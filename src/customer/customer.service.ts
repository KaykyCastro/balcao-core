import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, QueryFilter, Model } from 'mongoose';

import { CustomerSchema, CustomerDocument } from './schema/customer.schema';
import { CustomerPayment } from './schema/customer-payment.schema';
import { CustomerCreateDto } from './dto/customer-create.dto';
import { CustomerUpdateDto } from './dto/customer-update.dto';
import { CustomerPaymentDto } from './dto/customer-payment.dto';
import { PaginationQueryDto, Paginated } from '../common/dto/pagination-query.dto';
import { escapeRegex } from '../common/mongo';
import { toCents } from '../common/money';

@Injectable()
export class CustomerService {
  constructor(
    @InjectModel(CustomerSchema.name) private readonly customerModel: Model<CustomerSchema>,
    @InjectModel(CustomerPayment.name) private readonly paymentModel: Model<CustomerPayment>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  create(enterpriseId: string, dto: CustomerCreateDto): Promise<CustomerDocument> {
    return this.customerModel.create({ ...dto, enterpriseId });
  }

  async list(enterpriseId: string, q: PaginationQueryDto & { onlyWithDebt?: boolean }): Promise<Paginated<CustomerDocument>> {
    const filter: QueryFilter<CustomerSchema> = { enterpriseId };
    if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');
    if (q.onlyWithDebt) filter.debitCents = { $gt: 0 };
    const [items, total] = await Promise.all([
      this.customerModel.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.customerModel.countDocuments(filter),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async getCustomerById(enterpriseId: string, id: string): Promise<CustomerDocument> {
    const customer = await this.customerModel.findOne({ _id: id, enterpriseId });
    if (!customer) throw new NotFoundException('Cliente não encontrado');
    return customer;
  }

  async update(enterpriseId: string, id: string, dto: CustomerUpdateDto): Promise<CustomerDocument> {
    const updated = await this.customerModel.findOneAndUpdate(
      { _id: id, enterpriseId },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    );
    if (!updated) throw new NotFoundException('Cliente não encontrado');
    return updated;
  }

  async delete(enterpriseId: string, id: string): Promise<void> {
    const customer = await this.getCustomerById(enterpriseId, id);
    if ((customer.debitCents ?? 0) > 0) throw new ConflictException('Cliente com débito em aberto');
    await customer.deleteOne();
  }

  /** Soma ao fiado (atômico, dentro da transação da venda). */
  async increaseDebit(enterpriseId: string, id: string, cents: number, session?: ClientSession) {
    const customer = await this.customerModel.findOneAndUpdate(
      { _id: id, enterpriseId },
      { $inc: { debitCents: cents } },
      { returnDocument: 'after', session },
    );
    if (!customer) throw new NotFoundException('Cliente não encontrado');
    return customer;
  }

  /** Reduz o fiado até no máximo o saldo atual (usado no cancelamento de venda). */
  async reduceDebitUpTo(enterpriseId: string, id: string, cents: number, session?: ClientSession) {
    const full = await this.customerModel.findOneAndUpdate(
      { _id: id, enterpriseId, debitCents: { $gte: cents } },
      { $inc: { debitCents: -cents } },
      { session },
    );
    if (full) return;
    await this.customerModel.updateOne({ _id: id, enterpriseId }, { $set: { debitCents: 0 } }, { session });
  }

  /** Recebimento de fiado: não aceita valor maior que a dívida. */
  async receivePayment(enterpriseId: string, id: string, dto: CustomerPaymentDto) {
    const cents = toCents(dto.amount);
    const session = await this.connection.startSession();
    try {
      let result!: CustomerDocument;
      await session.withTransaction(async () => {
        const customer = await this.customerModel.findOneAndUpdate(
          { _id: id, enterpriseId, debitCents: { $gte: cents } },
          { $inc: { debitCents: -cents } },
          { returnDocument: 'after', session },
        );
        if (!customer) {
          const exists = await this.customerModel.exists({ _id: id, enterpriseId }).session(session);
          if (!exists) throw new NotFoundException('Cliente não encontrado');
          throw new UnprocessableEntityException('Valor maior que o débito do cliente');
        }
        await this.paymentModel.create(
          [{ enterpriseId, customerId: id, amountCents: cents, method: dto.method ?? 'cash' }],
          { session },
        );
        result = customer;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async listPayments(enterpriseId: string, id: string) {
    await this.getCustomerById(enterpriseId, id);
    return this.paymentModel.find({ enterpriseId, customerId: id }).sort({ createdAt: -1 }).limit(200);
  }
}
