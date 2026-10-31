import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { DebitSchema, DebitDocument } from './schema/debit.schema';
import { DebitCreateDto } from './dto/debit-create.dto';
import { ProductService } from '../products/product.service';
import { DebitItemService } from '../debit-item/debit-item.service';
import { CustomerService } from '../customer/customer.service';

@Injectable()
export class DebitService {
  constructor(
    @InjectModel(DebitSchema.name) private readonly debitModel: Model<DebitSchema>,
    @InjectConnection() private readonly connection: Connection,
    private readonly productService: ProductService,
    private readonly debitItemService: DebitItemService,
    private readonly customerService: CustomerService,
  ) {}

  async create(dto: DebitCreateDto): Promise<DebitDocument> {
    const customer = await this.customerService.getCustomerById(dto.enterpriseId, dto.customerId);
    if (!customer) throw new NotFoundException('Cliente não encontrado');

    let total = 0;
    const itemsToCreate: {
      productId: Types.ObjectId;
      productName: string;
      productCode: string;
      unitPrice: number;
      quantity: number;
      total: number;
    }[] = [];

    for (const { productId, quantity } of dto.items) {
      const product = await this.productService.getProductById(dto.enterpriseId, productId);
      if (!product) throw new NotFoundException(`Produto ${productId} não encontrado`);

      const unitPrice = (product.priceWithDiscount != 0) ? product.priceWithDiscount : product.price;
      const itemTotal = unitPrice * quantity;
      total += itemTotal;

      itemsToCreate.push({
        productId: product._id,
        productName: product.name,
        productCode: product.code,
        unitPrice,
        quantity, 
        total: itemTotal,
      });
    }

    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async () => {
        const debit = new this.debitModel({
          customerId: dto.customerId,
          total,
          debitItemsId: [],
        });

        for (const item of itemsToCreate) {
          const debitItem = await this.debitItemService.create(
            { ...item, debitId: debit._id },
            session,
          );

          this.productService.decreaseQuantity(dto.enterpriseId, item.productId.toString(), item.quantity, session);

          debit.debitItemsId.push(debitItem!._id);
        }
        
        await debit.save({ session });
        await this.customerService.increaseDebit(dto.enterpriseId, dto.customerId, total, session);
        return debit;
      });
    } finally {
      await session.endSession();
    }
  }
}