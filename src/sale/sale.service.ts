import { cashChange } from './cash';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, QueryFilter, Model, Types } from 'mongoose';

import { Sale, SaleDocument, SaleItem } from './schema/sale.schema';
import { SaleCreateDto } from './dto/sale-create.dto';
import { ProductService } from '../products/product.service';
import { effectivePrice } from '../products/schema/product.schema';
import { CustomerService } from '../customer/customer.service';
import { BillingService } from '../billing/billing.service';
import { PromotionService } from '../promotion/promotion.service';
import { PaginationQueryDto, Paginated } from '../common/dto/pagination-query.dto';
import { toCents } from '../common/money';
import { isDuplicateKeyError } from '../common/mongo';
import { promoUnits, promotionStatus } from '../promotion/promotion.rules';
import { applySaleDiscount, DEFAULT_STAFF_MAX_DISCOUNT_BPS, type SaleDiscountInput } from './discount.rules';

@Injectable()
export class SaleService {
  constructor(
    @InjectModel(Sale.name) private readonly saleModel: Model<Sale>,
    @InjectConnection() private readonly connection: Connection,
    private readonly productService: ProductService,
    private readonly customerService: CustomerService,
    private readonly billingService: BillingService,
    private readonly promotionService: PromotionService,
  ) {}

  /**
   * Total do carrinho agora, sem reservar nada (para cobrar na maquininha ou no Pix antes de registrar a venda).
   * A venda depois recalcula dentro da transação; se uma promoção acabar no meio, a diferença fica registrada.
   */
  /** Teto de desconto do colaborador (pontos-base); null = dono, sem teto. */
  private async staffDiscountCap(enterpriseId: string, staff?: { id: string } | null): Promise<number | null> {
    if (!staff) return null;
    const e = await this.connection.collection('enterpriseschemas').findOne({ _id: new Types.ObjectId(enterpriseId) }, { projection: { staffMaxDiscountBps: 1 } });
    return typeof e?.staffMaxDiscountBps === 'number' ? e.staffMaxDiscountBps : DEFAULT_STAFF_MAX_DISCOUNT_BPS;
  }

  async quote(enterpriseId: string, items: { productId: string; quantity: number }[], discount?: SaleDiscountInput | null, staff?: { id: string } | null): Promise<{ totalCents: number; subtotalCents: number; discountCents: number }> {
    const quantities = new Map<string, number>();
    for (const { productId, quantity } of items) quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
    const promos = await this.promotionService.activeFor(enterpriseId, [...quantities.keys()]);
    let totalCents = 0;
    for (const [productId, quantity] of quantities) {
      const p = await this.productService.getProductById(enterpriseId, productId);
      if (p.trackStock !== false && p.quantity < quantity) throw new ConflictException(`${p.name}: só há ${p.quantity} em estoque`);
      const normal = toCents(effectivePrice(p));
      const pr = promos.get(productId);
      const promoQty = pr && promotionStatus(pr) === 'active' && pr.promoPriceCents < normal ? Math.min(quantity, promoUnits(pr, quantity)) : 0;
      totalCents += promoQty * (pr?.promoPriceCents ?? 0) + (quantity - promoQty) * normal;
    }
    const off = applySaleDiscount(totalCents, discount, await this.staffDiscountCap(enterpriseId, staff));
    return { subtotalCents: totalCents, discountCents: off, totalCents: totalCents - off };
  }

  async create(enterpriseId: string, dto: SaleCreateDto, idempotencyKey?: string, payment?: Sale['payment'], staff?: { id: string; name: string } | null): Promise<SaleDocument> {
    if (idempotencyKey) {
      const prev = await this.saleModel.findOne({ enterpriseId, idempotencyKey });
      if (prev) return prev; // repetição do mesmo pedido: devolve a venda já feita
    }
    try {
      return await this.createOnce(enterpriseId, dto, idempotencyKey, payment, staff);
    } catch (e) {
      // Duas requisições simultâneas com a mesma chave: a segunda perde a corrida e recebe a venda da primeira.
      if (idempotencyKey && isDuplicateKeyError(e)) {
        const prev = await this.saleModel.findOne({ enterpriseId, idempotencyKey });
        if (prev) return prev;
      }
      throw e;
    }
  }

  private async createOnce(enterpriseId: string, dto: SaleCreateDto, idempotencyKey?: string, payment?: Sale['payment'], staff?: { id: string; name: string } | null): Promise<SaleDocument> {
    const isFiado = dto.paymentMethod === 'fiado';
    if (isFiado && !dto.customerId) throw new BadRequestException('Venda com pagamento posterior exige um cliente');
    if (dto.customerId) await this.customerService.getCustomerById(enterpriseId, dto.customerId); // 404 se não for da empresa
    if (isFiado) await this.customerService.assertCanOwe(enterpriseId, dto.customerId!); // conta do marketplace só depois de pertencer à loja

    // Junta linhas repetidas do mesmo produto.
    const quantities = new Map<string, number>();
    for (const { productId, quantity } of dto.items) {
      quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
    }

    const products = new Map<string, Awaited<ReturnType<ProductService['getProductById']>>>();
    for (const productId of quantities.keys()) products.set(productId, await this.productService.getProductById(enterpriseId, productId));

    const discountCap = dto.discount ? await this.staffDiscountCap(enterpriseId, staff) : null;
    const saleId = new Types.ObjectId();
    const session = await this.connection.startSession();
    try {
      let sale!: SaleDocument;
      await session.withTransaction(async () => {
        // Preços decididos dentro da transação: as unidades de promoção são reservadas junto com o estoque,
        // então duas vendas ao mesmo tempo nunca passam do limite da promoção.
        const items: SaleItem[] = [];
        let totalCents = 0;
        const promos = await this.promotionService.activeFor(enterpriseId, [...quantities.keys()], session);
        for (const [productId, quantity] of quantities) {
          const product = products.get(productId)!;
          const r = await this.productService.decreaseQuantity(enterpriseId, productId, quantity, session);
          const normalCents = toCents(effectivePrice(product));
          const originalUnitPriceCents = Math.max(toCents(product.price), normalCents);
          const base = { productId: product._id, productName: product.name, productCode: product.code, originalUnitPriceCents, stockTracked: r.tracked };
          const promo = promos.get(productId);
          // Promoção só vale se deixar mais barato que o preço atual.
          const promoQty = promo && promo.promoPriceCents < normalCents ? await this.promotionService.consume(promo, quantity, session) : 0;
          if (promoQty > 0) {
            items.push({ ...base, unitPriceCents: promo!.promoPriceCents, quantity: promoQty, totalCents: promo!.promoPriceCents * promoQty, promotionId: promo!._id });
            totalCents += promo!.promoPriceCents * promoQty;
          }
          const rest = quantity - promoQty; // passou do limite: o resto sai pelo preço normal
          if (rest > 0) {
            items.push({ ...base, unitPriceCents: normalCents, quantity: rest, totalCents: normalCents * rest });
            totalCents += normalCents * rest;
          }
        }

        // Desconto do carrinho: sobre o total já com promoções; nunca zera a venda; colaborador tem teto.
        const subtotalCents = totalCents;
        const discountCents = applySaleDiscount(subtotalCents, dto.discount, discountCap);
        totalCents = subtotalCents - discountCents;

        const cash = cashChange(dto.paymentMethod, totalCents, dto.cashReceivedCents); // valor recebido x total final

        // Taxa de 0,5% + teto de R$ 40: se bloqueado, lança 402 e a transação inteira é desfeita.
        const feeCents = await this.billingService.applyFee(enterpriseId, saleId, totalCents, session);
        if (isFiado) await this.customerService.increaseDebit(enterpriseId, dto.customerId!, totalCents, session);

        const [created] = await this.saleModel.create(
          [
            {
              _id: saleId,
              enterpriseId,
              customerId: dto.customerId ?? null,
              paymentMethod: dto.paymentMethod,
              items,
              totalCents,
              ...(discountCents > 0 ? { subtotalCents, discountCents, discount: { mode: dto.discount!.mode, value: dto.discount!.value, ...(dto.discount!.reason?.trim() ? { reason: dto.discount!.reason.trim() } : {}) } } : {}),
              feeCents,
              ...cash,
              ...(payment ? { payment } : {}),
              ...(staff ? { staff: { id: new Types.ObjectId(staff.id), name: staff.name } } : {}),
              ...(idempotencyKey ? { idempotencyKey } : {}),
            },
          ],
          { session },
        );
        sale = created;
      });
      return sale;
    } finally {
      await session.endSession();
    }
  }

  async list(
    enterpriseId: string,
    q: PaginationQueryDto & { customerId?: string; status?: 'completed' | 'cancelled' },
  ): Promise<Paginated<SaleDocument>> {
    const filter: QueryFilter<Sale> = { enterpriseId };
    if (q.customerId) filter.customerId = q.customerId;
    if (q.status) filter.status = q.status;
    const [items, total] = await Promise.all([
      this.saleModel.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.saleModel.countDocuments(filter),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async findById(enterpriseId: string, id: string): Promise<SaleDocument> {
    const sale = await this.saleModel.findOne({ _id: id, enterpriseId });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    return sale;
  }

  /**
   * Cancela a venda: repõe estoque, abate o fiado (até o saldo atual) e estorna a taxa
   * se ela ainda não tiver sido faturada. Taxa já faturada não é devolvida.
   */
  async cancel(enterpriseId: string, id: string, opts: { fromOrder?: boolean; session?: ClientSession } = {}): Promise<SaleDocument> {
    if (!opts.fromOrder) {
      const s0 = await this.saleModel.findOne({ _id: id, enterpriseId });
      if (s0?.channel === 'online') throw new ConflictException('Venda da loja online: cancele pelo pedido, em Pedidos.');
    }
    const run = async (session: ClientSession) => {
        const sale = await this.saleModel.findOneAndUpdate(
          { _id: id, enterpriseId, status: 'completed' },
          { $set: { status: 'cancelled', cancelledAt: new Date() } },
          { returnDocument: 'after', session },
        );
        if (!sale) {
          const exists = await this.saleModel.exists({ _id: id, enterpriseId }).session(session);
          if (!exists) throw new NotFoundException('Venda não encontrada');
          throw new ConflictException('Venda já cancelada');
        }

        for (const item of sale.items) {
          if (item.promotionId) await this.promotionService.release(item.promotionId, item.quantity, session);
          if (item.stockTracked === false) continue; // estoque ilimitado: nada a repor
          await this.productService.increaseQuantity(enterpriseId, String(item.productId), item.quantity, session);
        }
        if (sale.paymentMethod === 'fiado' && sale.customerId) {
          await this.customerService.reduceDebitUpTo(enterpriseId, String(sale.customerId), sale.totalCents, session);
        }
        const reversed = await this.billingService.reverseFee(enterpriseId, sale._id, session);
        if (reversed) {
          sale.feeReversed = true;
          await sale.save({ session });
        }
        return sale;
    };
    if (opts.session) return run(opts.session);
    const session = await this.connection.startSession();
    try {
      let result!: SaleDocument;
      await session.withTransaction(async () => { result = await run(session); });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Pedido online pago: registra a venda (estoque e promoção já foram reservados no pedido) e lança a taxa da loja online.
   * Roda dentro da transação do pedido. A taxa entra mesmo com a conta bloqueada: o cliente já pagou.
   */
  async recordOnlineSale(enterpriseId: string, p: { orderId: Types.ObjectId; items: SaleItem[]; totalCents: number; rateBps: number; collectedFeeCents: number; customerId?: Types.ObjectId | null }, session: ClientSession): Promise<SaleDocument> {
    const saleId = new Types.ObjectId();
    // Taxa da loja online: o Mercado Pago já separou (marketplace_fee). Só registra; não entra na fatura nem no teto.
    const feeCents = await this.billingService.recordCollectedFee(enterpriseId, saleId, p.totalCents, p.rateBps, p.collectedFeeCents, session);
    const [created] = await this.saleModel.create(
      [{ _id: saleId, enterpriseId, customerId: p.customerId ?? null, paymentMethod: 'online', channel: 'online', orderId: p.orderId, items: p.items, totalCents: p.totalCents, feeCents, cashReceivedCents: null, changeCents: null }],
      { session },
    );
    return created;
  }

  /** Pedido online pago na entrega/retirada: registra a venda (estoque já reservado) e a taxa da loja online vai para a fatura. */
  async recordCodSale(enterpriseId: string, p: { orderId: Types.ObjectId; items: SaleItem[]; subtotalCents: number; orderTotalCents: number; rateBps: number; paymentMethod: 'cash' | 'card' | 'pix' | 'other'; cashReceivedCents?: number | null; customerId?: Types.ObjectId | null }, session: ClientSession): Promise<SaleDocument> {
    const saleId = new Types.ObjectId();
    const cash = cashChange(p.paymentMethod, p.orderTotalCents, p.cashReceivedCents); // troco sobre o total com a entrega
    const feeCents = await this.billingService.recordUncollectedOnlineFee(enterpriseId, saleId, p.subtotalCents, p.rateBps, session);
    const [created] = await this.saleModel.create(
      [{ _id: saleId, enterpriseId, customerId: p.customerId ?? null, paymentMethod: p.paymentMethod, channel: 'online', orderId: p.orderId, items: p.items, totalCents: p.subtotalCents, feeCents, ...cash }],
      { session },
    );
    return created;
  }

  /**
   * Comanda de mesa paga: registra a venda (estoque e promoção já reservados ao lançar cada item).
   * A taxa do ERP é a do balcão (0,5%, sobre os itens) e entra mesmo com a conta bloqueada: o cliente já consumiu e pagou.
   */
  async recordTabSale(enterpriseId: string, p: {
    tabId: Types.ObjectId; tab: { table: number; number: number; name: string; label: string }; items: SaleItem[]; subtotalCents: number; serviceCents: number;
    paymentMethod: 'cash' | 'pix' | 'card' | 'other' | 'online'; cashReceivedCents?: number | null; payment?: Sale['payment']; staff?: { id: string; name: string } | null;
  }, session: ClientSession): Promise<SaleDocument> {
    const saleId = new Types.ObjectId();
    const totalCents = p.subtotalCents + p.serviceCents;
    const cash = cashChange(p.paymentMethod, totalCents, p.cashReceivedCents);
    const feeCents = await this.billingService.applyFee(enterpriseId, saleId, p.subtotalCents, session, { allowBlocked: true });
    const [created] = await this.saleModel.create(
      [{ _id: saleId, enterpriseId, customerId: null, paymentMethod: p.paymentMethod, channel: 'pos', tabId: p.tabId, tab: p.tab, items: p.items, totalCents, serviceCents: p.serviceCents, feeCents, ...cash, ...(p.staff ? { staff: { id: new Types.ObjectId(p.staff.id), name: p.staff.name } } : {}), ...(p.payment ? { payment: p.payment } : {}) }],
      { session },
    );
    return created;
  }

  /** Compras de um cliente (balcão e online), mais recentes primeiro. Usado em "Minha conta" do comprador. */
  forCustomer(enterpriseId: string | Types.ObjectId, customerId: string | Types.ObjectId, limit = 60) {
    return this.saleModel.find({ enterpriseId, customerId, status: 'completed' }).sort({ createdAt: -1 }).limit(limit).lean();
  }
}
