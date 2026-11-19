import { cashChange } from './cash';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { judgePaymentEdit, PaymentEditError, dueOf, EDITABLE_METHODS } from './payment-edit.rules';
import { escapeRegex } from '../common/mongo';
import { periodRange } from '../common/period';
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
import { groupSaleLines, splitPromoUnits, type SaleLineIn } from './lines.rules';
import { OptionsError, type OptionGroup } from '../products/options.rules';
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
    @Optional() private readonly enterprises?: EnterpriseService,
  ) {}

  /**
   * Total do carrinho agora, sem reservar nada (para cobrar na maquininha ou no Pix antes de registrar a venda).
   * A venda depois recalcula dentro da transação; se uma promoção acabar no meio, a diferença fica registrada.
   */
  /** Teto de desconto do colaborador (pontos-base); null = dono, sem teto. */
  private async staffDiscountCap(enterpriseId: string, staff?: { id: string } | null): Promise<number | null> {
    if (!staff) return null;
    const col = this.connection.collection('enterpriseschemas');
    let e = await col.findOne({ _id: new Types.ObjectId(enterpriseId) }, { projection: { staffMaxDiscountBps: 1, parentId: 1 } });
    if (e?.parentId) e = await col.findOne({ _id: e.parentId }, { projection: { staffMaxDiscountBps: 1 } }); // filial: o limite é o da matriz
    return typeof e?.staffMaxDiscountBps === 'number' ? e.staffMaxDiscountBps : DEFAULT_STAFF_MAX_DISCOUNT_BPS;
  }

  /** Confere as opções escolhidas e junta as linhas por produto (422 OPTIONS_INVALID se a escolha não vale). */
  private lines(items: SaleLineIn[], products: Map<string, { name: string; options?: OptionGroup[] | null }>) {
    try { return groupSaleLines(items, (id) => products.get(id)!); } catch (e) {
      if (e instanceof OptionsError) throw new UnprocessableEntityException({ statusCode: 422, code: 'OPTIONS_INVALID', message: e.message });
      throw e;
    }
  }

  async quote(enterpriseId: string, items: SaleLineIn[], discount?: SaleDiscountInput | null, staff?: { id: string } | null): Promise<{ totalCents: number; subtotalCents: number; discountCents: number }> {
    const ids = [...new Set(items.map((i) => i.productId))];
    const products = new Map<string, Awaited<ReturnType<ProductService['getProductById']>>>();
    for (const id of ids) products.set(id, await this.productService.getProductById(enterpriseId, id));
    const grouped = this.lines(items, products as Map<string, { name: string; options?: OptionGroup[] | null }>);
    const promos = await this.promotionService.activeFor(enterpriseId, ids);
    let totalCents = 0;
    for (const [productId, g] of grouped) {
      const p = products.get(productId)!; const quantity = g.quantity;
      if (p.trackStock !== false && p.quantity < quantity) throw new ConflictException(`${p.name}: só há ${p.quantity} em estoque`);
      const normal = toCents(effectivePrice(p));
      const pr = promos.get(productId);
      const promoQty = pr && promotionStatus(pr) === 'active' && pr.promoPriceCents < normal ? Math.min(quantity, promoUnits(pr, quantity)) : 0;
      for (const part of splitPromoUnits(g.lines, promoQty, pr?.promoPriceCents ?? 0, normal)) totalCents += part.unitCents * part.quantity;
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
    const prep = await this.prepare(enterpriseId, dto, staff);
    const session = await this.connection.startSession();
    try {
      let sale!: SaleDocument;
      await session.withTransaction(async () => {
        sale = await this.write(enterpriseId, dto, prep, session, { saleId: new Types.ObjectId(), idempotencyKey, payment, staff });
      });
      return sale;
    } finally {
      await session.endSession();
    }
  }

  /** Conferências e leituras antes da transação (cliente, produtos, teto de desconto). */
  async prepare(enterpriseId: string, dto: SaleCreateDto, staff?: { id: string } | null) {
    const isFiado = dto.paymentMethod === 'fiado';
    if (isFiado && !dto.customerId) throw new BadRequestException('Venda com pagamento posterior exige um cliente');
    if (dto.useCreditCents && !dto.customerId) throw new BadRequestException('Para usar o crédito da loja, escolha o cliente');
    if (dto.customerId) await this.customerService.getCustomerById(enterpriseId, dto.customerId); // 404 se não for da empresa
    if (isFiado) await this.customerService.assertCanOwe(enterpriseId, dto.customerId!); // conta do marketplace só depois de pertencer à loja

    // Junta linhas repetidas do mesmo produto (e, dentro dele, a mesma escolha de opções + observação).
    const products = new Map<string, Awaited<ReturnType<ProductService['getProductById']>>>();
    for (const productId of new Set(dto.items.map((i) => i.productId))) products.set(productId, await this.productService.getProductById(enterpriseId, productId));
    const grouped = this.lines(dto.items, products as Map<string, { name: string; options?: OptionGroup[] | null }>);
    const discountCap = dto.discount ? await this.staffDiscountCap(enterpriseId, staff) : null;
    return { products, grouped, discountCap };
  }

  /**
   * Grava a venda DENTRO da transação de quem chama (venda comum ou troca). Baixa estoque e promoções, aplica o desconto,
   * usa o valor de uma troca (`exchange`) e/ou o crédito da loja do cliente (`dto.useCreditCents`) e cobra o resto por
   * `paymentMethod`. A taxa do Balcão é só sobre o dinheiro novo (o valor da troca e o crédito já pagaram taxa antes).
   */
  async write(
    enterpriseId: string, dto: SaleCreateDto, prep: Awaited<ReturnType<SaleService['prepare']>>, session: ClientSession,
    opts: { saleId: Types.ObjectId; idempotencyKey?: string; payment?: Sale['payment']; staff?: { id: string; name: string } | null; exchange?: { id: Types.ObjectId; cents: number } },
  ): Promise<SaleDocument> {
    const { products, grouped, discountCap } = prep;
    const saleId = opts.saleId;
    // Preços decididos dentro da transação: as unidades de promoção são reservadas junto com o estoque,
    // então duas vendas ao mesmo tempo nunca passam do limite da promoção.
    const items: SaleItem[] = [];
    let totalCents = 0;
    const promos = await this.promotionService.activeFor(enterpriseId, [...grouped.keys()], session);
    for (const [productId, g] of grouped) {
      const quantity = g.quantity;
      const product = products.get(productId)!;
      const r = await this.productService.decreaseQuantity(enterpriseId, productId, quantity, session);
      const normalCents = toCents(effectivePrice(product));
      const originalUnitPriceCents = Math.max(toCents(product.price), normalCents);
      const base = { productId: product._id, productName: product.name, productCode: product.code, originalUnitPriceCents, stockTracked: r.tracked };
      const promo = promos.get(productId);
      // Promoção só vale se deixar mais barato que o preço atual.
      const promoQty = promo && promo.promoPriceCents < normalCents ? await this.promotionService.consume(promo, quantity, session) : 0;
      // Cada linha: preço base (promoção até o limite, depois o normal) + o adicional das opções escolhidas.
      for (const part of splitPromoUnits(g.lines, promoQty, promo?.promoPriceCents ?? 0, normalCents)) {
        items.push({
          ...base, unitPriceCents: part.unitCents, quantity: part.quantity, totalCents: part.unitCents * part.quantity,
          ...(part.promo ? { promotionId: promo!._id } : {}),
          ...(part.line.picked.length ? { options: part.line.picked } : {}), ...(part.line.note ? { note: part.line.note } : {}),
        });
        totalCents += part.unitCents * part.quantity;
      }
    }

    // Desconto do carrinho: sobre o total já com promoções; nunca zera a venda; colaborador tem teto.
    const subtotalCents = totalCents;
    const discountCents = applySaleDiscount(subtotalCents, dto.discount, discountCap);
    totalCents = subtotalCents - discountCents;

    // O que já está pago: valor da troca e crédito da loja (nunca mais que o total). O resto é cobrado agora.
    const exchangeCents = Math.min(opts.exchange?.cents ?? 0, totalCents);
    const creditCents = Math.min(dto.useCreditCents ?? 0, totalCents - exchangeCents);
    const dueCents = totalCents - exchangeCents - creditCents;
    const paymentMethod: Sale['paymentMethod'] = dueCents > 0 ? dto.paymentMethod : exchangeCents > 0 ? 'exchange' : creditCents > 0 ? 'credit' : dto.paymentMethod;
    const isFiado = paymentMethod === 'fiado';

    const cash = cashChange(paymentMethod, dueCents, dueCents > 0 ? dto.cashReceivedCents : null); // valor recebido x o que falta pagar

    // Taxa de 0,5% + teto de R$ 40 sobre o dinheiro novo: se bloqueado, lança 402 e a transação inteira é desfeita.
    const feeCents = dueCents > 0 ? await this.billingService.applyFee(enterpriseId, saleId, dueCents, session) : 0;
    if (isFiado) await this.customerService.increaseDebit(enterpriseId, dto.customerId!, dueCents, session);
    if (creditCents > 0) await this.customerService.spendCredit(enterpriseId, dto.customerId!, creditCents, { saleId, by: opts.staff ?? null }, session);

    const [created] = await this.saleModel.create(
      [
        {
          _id: saleId,
          enterpriseId,
          customerId: dto.customerId ?? null,
          paymentMethod,
          items,
          totalCents,
          ...(discountCents > 0 ? { subtotalCents, discountCents, discount: { mode: dto.discount!.mode, value: dto.discount!.value, ...(dto.discount!.reason?.trim() ? { reason: dto.discount!.reason.trim() } : {}) } } : {}),
          ...(creditCents > 0 ? { creditCents } : {}),
          ...(opts.exchange ? { exchangeId: opts.exchange.id, exchangeCents } : {}),
          feeCents,
          ...cash,
          ...(opts.payment ? { payment: opts.payment } : {}),
          ...(opts.staff ? { staff: { id: new Types.ObjectId(opts.staff.id), name: opts.staff.name } } : {}),
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        },
      ],
      { session },
    );
    return created;
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

  /**
   * Lista para a página "Gestão de vendas": período (dia de Brasília), canal, situação, forma e busca por
   * número do comprovante, cliente, produto ou colaborador. Já vem com o nome do cliente e o que dá para corrigir.
   */
  async manage(enterpriseId: string, q: { page: number; limit: number; channel?: 'pos' | 'online'; status?: 'completed' | 'cancelled'; paymentMethod?: string; from?: string; to?: string; search?: string }) {
    const eid = new Types.ObjectId(enterpriseId);
    const filter: Record<string, unknown> = { enterpriseId: eid };
    if (q.channel === 'online') filter.channel = 'online';
    else if (q.channel === 'pos') filter.channel = { $ne: 'online' };
    if (q.status) filter.status = q.status;
    if (q.paymentMethod) filter.paymentMethod = q.paymentMethod;
    const range = periodRange(q.from, q.to);
    if (range) filter.createdAt = range;
    const term = (q.search ?? '').replace(/^\s*n[ºo°]?\s*/i, '').trim().slice(0, 60);
    if (term) {
      const rx = { $regex: escapeRegex(term), $options: 'i' };
      const custIds = (await this.connection.collection('customerschemas').find({ enterpriseId: eid, name: rx }, { projection: { _id: 1 } }).limit(200).toArray()).map((c) => c._id);
      filter.$or = [
        ...(/^[0-9a-f]{1,24}$/i.test(term) ? [{ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${escapeRegex(term.toLowerCase())}$` } } }] : []),
        { 'items.productName': rx }, { 'staff.name': rx },
        ...(custIds.length ? [{ customerId: { $in: custIds } }] : []),
      ];
    }
    const [rows, total] = await Promise.all([
      this.saleModel.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      this.saleModel.countDocuments(filter),
    ]);
    const ids = [...new Set(rows.map((r) => r.customerId && String(r.customerId)).filter(Boolean) as string[])];
    const names = new Map(ids.length ? (await this.connection.collection('customerschemas').find({ enterpriseId: eid, _id: { $in: ids.map((x) => new Types.ObjectId(x)) } }, { projection: { name: 1 } }).toArray()).map((c) => [String(c._id), c.name as string]) : []);
    return {
      items: rows.map((r) => {
        let editable: string | null = null;
        try { judgePaymentEdit(r as never, r.paymentMethod === 'cash' ? 'pix' : 'cash'); } catch (e) { editable = e instanceof PaymentEditError ? e.code : 'PAYMENT_EDIT'; }
        return { ...r, customerName: r.customerId ? names.get(String(r.customerId)) ?? '' : '', dueCents: dueOf(r), editBlock: editable };
      }),
      total, page: q.page, limit: q.limit,
    };
  }

  /**
   * Corrige a forma de pagamento de uma venda do balcão. Motivo obrigatório e SEMPRE a senha do dono (mesmo com um
   * colaborador logado). Fiado entra/sai da dívida do cliente na mesma transação. Cada correção fica gravada na venda.
   */
  async editPayment(enterpriseId: string, id: string, dto: { paymentMethod: string; reason: string; ownerPassword: string }, who: { id: string; name: string } | null) {
    const reason = (dto.reason ?? '').replace(/\s+/g, ' ').trim();
    if (reason.length < 3) throw new ConflictException({ statusCode: 409, code: 'PAYMENT_EDIT_REASON', message: 'Explique o motivo da correção (ex.: o cliente pagou em dinheiro, não no Pix).' });
    const fail = (e: unknown): never => {
      if (e instanceof PaymentEditError) throw new ConflictException({ statusCode: 409, code: e.code, message: e.message });
      throw e;
    };
    // Confere antes de pedir a senha, para não gastar tentativa numa venda que nem dá para corrigir.
    const before = await this.saleModel.findOne({ _id: id, enterpriseId }).lean();
    if (!before) throw new NotFoundException('Venda não encontrada');
    try { judgePaymentEdit(before as never, dto.paymentMethod); } catch (e) { fail(e); }
    if (!this.enterprises) throw new ConflictException('Indisponível');
    await this.enterprises.verifyOwnerPassword(enterpriseId, dto.ownerPassword);

    const session = await this.connection.startSession();
    try {
      let out!: SaleDocument;
      await session.withTransaction(async () => {
        const sale = await this.saleModel.findOne({ _id: id, enterpriseId }).session(session);
        if (!sale) throw new NotFoundException('Venda não encontrada');
        let judged!: ReturnType<typeof judgePaymentEdit>;
        try { judged = judgePaymentEdit(sale, dto.paymentMethod); } catch (e) { fail(e); }
        const cust = sale.customerId ? String(sale.customerId) : null;
        if (judged.debtDelta > 0) {
          await this.customerService.assertCanOwe(enterpriseId, cust!);
          await this.customerService.increaseDebit(enterpriseId, cust!, judged.debtDelta, session);
        } else if (judged.debtDelta < 0 && cust) {
          const ok = await this.customerService.reduceDebitExact(enterpriseId, cust, -judged.debtDelta, session);
          if (!ok) throw new ConflictException({ statusCode: 409, code: 'PAYMENT_EDIT_FIADO_PAID', message: 'Parte deste fiado já foi paga pelo cliente. Ajuste pela ficha do cliente em vez de trocar a forma da venda.' });
        }
        const from = sale.paymentMethod;
        const r = await this.saleModel.findOneAndUpdate(
          { _id: sale._id, enterpriseId, paymentMethod: from, status: 'completed' },
          {
            $set: { paymentMethod: dto.paymentMethod, cashReceivedCents: null, changeCents: null },
            $push: { paymentEdits: { from, to: dto.paymentMethod, reason: reason.slice(0, 200), at: new Date(), by: who ? { name: who.name, staffId: new Types.ObjectId(who.id) } : { name: 'Dono', staffId: null } } },
          },
          { returnDocument: 'after', session },
        );
        if (!r) throw new ConflictException({ statusCode: 409, code: 'PAYMENT_EDIT_CHANGED', message: 'A venda mudou enquanto você corrigia. Abra de novo e confira.' });
        out = r;
      });
      return out;
    } finally {
      await session.endSession();
    }
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
      if (s0?.exchangeId) throw new ConflictException({ statusCode: 409, code: 'SALE_FROM_EXCHANGE', message: 'Esta venda saiu de uma troca. Para desfazer, faça uma nova troca dentro do prazo.' });
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
        const paidBefore = (sale.creditCents ?? 0) + (sale.exchangeCents ?? 0);
        if (sale.paymentMethod === 'fiado' && sale.customerId) {
          await this.customerService.reduceDebitUpTo(enterpriseId, String(sale.customerId), sale.totalCents - paidBefore, session);
        }
        // Crédito da loja usado nesta venda volta para o cliente.
        if ((sale.creditCents ?? 0) > 0 && sale.customerId) {
          await this.customerService.addCredit(enterpriseId, String(sale.customerId), sale.creditCents!, { kind: 'estorno', saleId: sale._id }, session);
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
  async recordOnlineSale(enterpriseId: string, p: { orderId: Types.ObjectId; items: SaleItem[]; totalCents: number; rateBps: number; collectedFeeCents: number; feeCollection?: 'split' | 'invoice'; customerId?: Types.ObjectId | null }, session: ClientSession): Promise<SaleDocument> {
    const saleId = new Types.ObjectId();
    // Taxa da loja online. OAuth ('split'): o Mercado Pago já separou (marketplace_fee); só registra, não entra na fatura
    // nem no teto. Modo token ('invoice'): o Mercado Pago não separou nada, então vira dívida e entra na fatura do mês
    // (como no pagar na entrega); cancelar/devolver antes de faturar estorna (SaleService.cancel → reverseFee).
    const feeCents = p.feeCollection === 'invoice'
      ? await this.billingService.recordUncollectedOnlineFee(enterpriseId, saleId, p.totalCents, p.rateBps, session)
      : await this.billingService.recordCollectedFee(enterpriseId, saleId, p.totalCents, p.rateBps, p.collectedFeeCents, session);
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

