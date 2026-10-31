import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schema/order.schema';
import { StoreDocument } from './schema/store.schema';
import { CheckoutDto, OrderCancelDto, OrderListQueryDto, OrderStatusDto } from './dto/order.dto';
import { PricedLine, StoreService } from './store.service';
import { randomToken, sha256, sign, verifySigned } from './secret-box';
import { canCancel, canMove, isPaidLike, ORDER_STATUS_LABEL, PAYMENT_WINDOW_MIN, trackingUrlFor, type OrderStatus } from './store.rules';
import { ProductService } from '../products/product.service';
import { effectivePrice } from '../products/schema/product.schema';
import { PromotionService } from '../promotion/promotion.service';
import { SaleService } from '../sale/sale.service';
import { SaleItem } from '../sale/schema/sale.schema';
import { MercadoPagoClient } from './mercadopago.client';
import { BillingService, onlineFeeCents } from '../billing/billing.service';
import { feeWaived } from '../billing/billing.rules';
import { MailService } from '../mail/mail.service';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { toCents } from '../common/money';
import { escapeRegex } from '../common/mongo';

const SCOPE = 'store-order';
const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectConnection() private readonly connection: Connection,
    private readonly stores: StoreService,
    private readonly products: ProductService,
    private readonly promotions: PromotionService,
    private readonly sales: SaleService,
    private readonly mp: MercadoPagoClient,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly enterprises: EnterpriseService,
    private readonly billing: BillingService,
  ) {}

  private get api() { return (this.config.get<string>('APP_URL') ?? '').replace(/\/$/, ''); }
  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, ''); }

  // ------------------------------------------------------------------ carrinho e frete (público)

  /** Junta itens repetidos e confere se os produtos estão publicados. Preço "de vitrine" (promoção sem reservar). */
  async priceCart(store: StoreDocument, items: { productId: string; quantity: number }[]): Promise<PricedLine[]> {
    const qty = new Map<string, number>();
    for (const i of items) qty.set(i.productId, Math.min(999, (qty.get(i.productId) ?? 0) + i.quantity));
    const eid = String(store.enterpriseId);
    const list = await this.products.publicMany(eid, [...qty.keys()]);
    if (list.length !== qty.size) throw new UnprocessableEntityException('Algum produto do carrinho não está mais disponível. Atualize a página.');
    const promos = await this.promotions.activeFor(eid, list.map((p) => p._id));
    return list.map((p) => {
      const normal = toCents(effectivePrice(p));
      const pr = promos.get(String(p._id));
      const unit = pr && pr.promoPriceCents < normal ? pr.promoPriceCents : normal;
      return { productId: String(p._id), name: p.name, quantity: qty.get(String(p._id))!, unitCents: unit, dims: p };
    });
  }

  async quote(slug: string, cep: string, items: { productId: string; quantity: number }[]) {
    const { store } = await this.stores.publicBySlug(slug);
    const lines = await this.priceCart(store, items);
    const options = await this.stores.quote(store, cep, lines);
    return { options, subtotalCents: lines.reduce((s, l) => s + l.unitCents * l.quantity, 0) };
  }

  // ------------------------------------------------------------------ checkout (público)

  /**
   * Cria o pedido reservando estoque e unidades de promoção (como uma venda), e gera o pagamento no Mercado Pago
   * NA CONTA DO LOJISTA, com a taxa do Balcão como `marketplace_fee` (separada automaticamente no pagamento).
   * Sem pagamento em PAYMENT_WINDOW_MIN minutos, a reserva volta para o estoque.
   */
  async checkout(slug: string, dto: CheckoutDto) {
    const { store } = await this.stores.publicBySlug(slug, { forOrder: true });
    if (!store.mp?.userId) throw new ConflictException('Esta loja ainda não configurou o pagamento');
    const eid = String(store.enterpriseId);

    // Frete recalculado no servidor para a opção escolhida.
    const preview = await this.priceCart(store, dto.items);
    const options = await this.stores.quote(store, dto.address?.cep ?? null, preview);
    const ship = options.find((o) => o.id === dto.shippingOptionId);
    if (!ship) throw new UnprocessableEntityException('Forma de entrega indisponível para esse endereço. Calcule o frete de novo.');
    if (ship.kind !== 'pickup' && !dto.address) throw new BadRequestException('Informe o endereço de entrega');

    const source = dto.source === 'directory' ? 'directory' : 'store';
    const feeRateBps = await this.billing.onlineRate(source);
    const owner = await this.enterprises.findEnterpriseById(eid).catch(() => null);
    const waived = !!owner && !!feeWaived(owner);
    const token = randomToken();
    const orderId = new Types.ObjectId();
    const session = await this.connection.startSession();
    let order!: OrderDocument;
    try {
      await session.withTransaction(async () => {
        const items: SaleItem[] = [];
        const promos = await this.promotions.activeFor(eid, preview.map((l) => l.productId), session);
        for (const l of preview) {
          const p = (await this.products.publicMany(eid, [l.productId]))[0];
          const r = await this.products.decreaseQuantity(eid, l.productId, l.quantity, session);
          const normal = toCents(effectivePrice(p));
          const base = { productId: p._id as Types.ObjectId, productName: p.name, productCode: p.code, originalUnitPriceCents: Math.max(toCents(p.price), normal), stockTracked: r.tracked };
          const pr = promos.get(l.productId);
          const promoQty = pr && pr.promoPriceCents < normal ? await this.promotions.consume(pr, l.quantity, session) : 0;
          if (promoQty > 0) items.push({ ...base, unitPriceCents: pr!.promoPriceCents, quantity: promoQty, totalCents: pr!.promoPriceCents * promoQty, promotionId: pr!._id });
          if (l.quantity - promoQty > 0) items.push({ ...base, unitPriceCents: normal, quantity: l.quantity - promoQty, totalCents: normal * (l.quantity - promoQty) });
        }
        const subtotalCents = items.reduce((s, i) => s + i.totalCents, 0);
        if (store.minOrderCents && subtotalCents < store.minOrderCents) throw new UnprocessableEntityException(`Pedido mínimo desta loja: ${fmt(store.minOrderCents)}`);
        const number = await this.stores.nextOrderNumber(store._id, session);
        const now = new Date();
        [order] = await this.orders.create([{
          _id: orderId, enterpriseId: store.enterpriseId, storeId: store._id, storeSlug: store.slug, number, status: 'pending_payment',
          items, subtotalCents, totalCents: subtotalCents + ship.priceCents,
          shipping: { optionId: ship.id, kind: ship.kind, name: ship.name, carrier: ship.carrier, priceCents: ship.priceCents, etaText: ship.etaText },
          customer: { name: dto.customer.name.trim(), email: dto.customer.email.trim().toLowerCase(), phone: dto.customer.phone, document: dto.customer.document || undefined },
          address: ship.kind === 'pickup' ? null : { ...dto.address!, state: dto.address!.state.toUpperCase() },
          notes: dto.notes?.trim() ?? '', provider: 'mercadopago', payeeId: store.mp.userId, accessHash: sha256(token),
          source, feeRateBps, feeCents: waived ? 0 : onlineFeeCents(subtotalCents, feeRateBps), feeCharged: false,
          expiresAt: new Date(now.getTime() + PAYMENT_WINDOW_MIN * 60_000), history: [{ status: 'pending_payment', at: now }],
          payment: { checkoutUrl: null, preferenceId: null, paymentId: null, method: null, paidAmountCents: null, paidAt: null, refundedAt: null },
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    // Pagamento fora da transação (chamada externa). Se falhar, devolve a reserva.
    try {
      const oid = String(order._id);
      const accessToken = await this.stores.mpAccessToken(store._id);
      const pref = await this.mp.createPreference({
        accessToken, orderId: oid, marketplaceFeeCents: order.feeCents, expiresAt: order.expiresAt, statementDescriptor: store.name,
        items: [
          ...order.items.map((i) => ({ title: i.productName, quantity: i.quantity, unitCents: i.unitPriceCents })),
          ...(order.shipping.priceCents > 0 ? [{ title: `Frete - ${order.shipping.name}`, quantity: 1, unitCents: order.shipping.priceCents }] : []),
        ],
        payer: { name: order.customer.name, email: order.customer.email, phone: order.customer.phone },
        backUrl: `${this.front}/loja/${store.slug}/pedido/${oid}?t=${token}`,
        notificationUrl: this.api.startsWith('https://') ? `${this.api}/public/store-webhook/mercadopago?o=${oid}&s=${sign(SCOPE, oid)}` : undefined,
      });
      await this.orders.updateOne({ _id: order._id }, { $set: { 'payment.checkoutUrl': pref.initPoint, 'payment.preferenceId': pref.id } });
      return { orderId: oid, number: order.number, token, checkoutUrl: pref.initPoint, totalCents: order.totalCents };
    } catch (e) {
      await this.release(order._id, 'cancelled', 'Falha ao gerar o pagamento').catch((err) => this.logger.error(`Reserva presa no pedido ${order._id}: ${err.message}`));
      throw e;
    }
  }

  // ------------------------------------------------------------------ acompanhamento (público)

  private async byToken(slug: string, id: string, t: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Pedido não encontrado');
    const o = await this.orders.findOne({ _id: id, storeSlug: String(slug).toLowerCase() }).select('+accessHash');
    if (!o || o.accessHash !== sha256(t)) throw new NotFoundException('Pedido não encontrado');
    return o;
  }

  async publicView(slug: string, id: string, t: string) {
    return this.present(await this.byToken(slug, id, t), true);
  }

  /** Cliente voltou do Mercado Pago: confirma na hora consultando o pagamento (o webhook pode demorar). */
  async confirmFromRedirect(slug: string, id: string, p: { t: string; paymentId: string }) {
    const o = await this.byToken(slug, id, p.t);
    const outcome = await this.syncPayment(o, p.paymentId);
    return { outcome, order: this.present((await this.orders.findById(o._id))!, true) };
  }

  /** Webhook do Mercado Pago (URL com token por pedido + consulta do pagamento na conta do lojista). */
  async webhook(q: Record<string, unknown>, body: Record<string, any>, headers: { signature?: string; requestId?: string }) {
    const oid = String(q.o ?? '');
    if (!/^[a-f0-9]{24}$/i.test(oid) || !verifySigned(SCOPE, oid, q.s)) throw new UnauthorizedException('Token inválido');
    const topic = String(q.type ?? q.topic ?? body?.type ?? body?.topic ?? '');
    const paymentId = String(q['data.id'] ?? body?.data?.id ?? (topic === 'payment' ? q.id ?? '' : '') ?? '');
    if (topic !== 'payment' || !/^\d{1,20}$/.test(paymentId)) return { received: true, outcome: 'ignored' };
    if (headers.signature && !this.mp.verifySignature(paymentId, headers.requestId, headers.signature)) throw new UnauthorizedException('Assinatura inválida');
    const o = await this.orders.findById(oid);
    if (!o) return { received: true, outcome: 'order_not_found' };
    const outcome = await this.syncPayment(o, paymentId);
    this.logger.log(`Webhook pedido ${oid} (pagamento ${paymentId}): ${outcome}`);
    return { received: true, outcome };
  }

  /** Lê o pagamento no Mercado Pago e aplica: aprovado vira venda; estornado depois de pago cancela o pedido. */
  private async syncPayment(o: OrderDocument, paymentId: string): Promise<string> {
    if (!/^\d{1,20}$/.test(paymentId)) return 'unverifiable';
    const token = await this.stores.mpAccessToken(o.storeId);
    const pay = await this.mp.payment(paymentId, token);
    if (pay.externalReference !== String(o._id)) { this.logger.warn(`Pagamento ${paymentId} não é do pedido ${o._id}`); return 'not_this_order'; }
    if (o.payeeId && pay.collectorId && pay.collectorId !== o.payeeId) { this.logger.error(`Pagamento ${paymentId} caiu em outra conta`); return 'wrong_account'; }
    if (pay.status === 'approved') {
      if (isPaidLike(o.status)) return 'already_paid';
      if (pay.amountCents < o.totalCents) { this.logger.error(`Valor divergente no pedido ${o._id}: esperado=${o.totalCents} pago=${pay.amountCents}`); return 'amount_mismatch'; }
      const applied = await this.markPaid(o._id, { paymentId: pay.id, method: pay.method ?? undefined, paidAmountCents: pay.amountCents, feeCents: pay.marketplaceFeeCents });
      return applied ? 'applied' : 'already_paid';
    }
    if (['refunded', 'charged_back'].includes(pay.status)) {
      await this.onRefunded(o, pay.status === 'charged_back' ? 'Contestação no cartão (chargeback)' : 'Pagamento devolvido no Mercado Pago');
      return 'refunded';
    }
    return pay.status === 'rejected' || pay.status === 'cancelled' ? 'not_paid' : 'pending';
  }

  /** Dinheiro devolvido ao comprador (pelo Balcão ou direto no Mercado Pago): pedido cancelado, venda desfeita, comissão devolvida junto. */
  private async onRefunded(o: OrderDocument, reason: string) {
    const now = new Date();
    if (o.status === 'cancelled') {
      await this.orders.updateOne({ _id: o._id }, { $set: { refundNeeded: false, 'payment.refundedAt': now, feeCents: 0 } });
    } else if (isPaidLike(o.status)) {
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          const r = await this.orders.findOneAndUpdate({ _id: o._id, status: o.status }, { $set: { status: 'cancelled', cancelReason: reason, refundNeeded: false, stockReleased: true, 'payment.refundedAt': now, feeCents: 0 }, $push: { history: { status: 'cancelled', at: now, note: reason } } }, { session });
          if (r && o.saleId) await this.sales.cancel(String(o.enterpriseId), String(o.saleId), { fromOrder: true, session });
        });
      } finally {
        await session.endSession();
      }
    }
    if (o.saleId) await this.billing.reverseCollectedFee(o.saleId).catch(() => undefined);
  }

  /**
   * Pagamento confirmado: vira venda e aparece em Pedidos. A taxa do Balcão já veio separada pelo Mercado Pago
   * (marketplace_fee): só registramos, não entra na fatura.
   * Se o pedido já tinha expirado (estoque devolvido), tenta reservar de novo; faltando, marca para o lojista resolver.
   * Pedido cancelado pelo lojista que é pago mesmo assim fica pago, com aviso de reembolso.
   */
  async markPaid(id: Types.ObjectId, info: { paymentId: string; method?: string; paidAmountCents: number; feeCents: number }): Promise<boolean> {
    const session = await this.connection.startSession();
    let changed = false, order: OrderDocument | null = null;
    try {
      await session.withTransaction(async () => {
        changed = false;
        const now = new Date();
        const o = await this.orders.findOneAndUpdate(
          { _id: id, status: { $in: ['pending_payment', 'expired', 'cancelled'] }, saleId: null },
          { $set: { status: 'paid', 'payment.paymentId': info.paymentId, 'payment.method': info.method ?? null, 'payment.paidAmountCents': info.paidAmountCents, 'payment.paidAt': now, seen: false }, $push: { history: { status: 'paid', at: now } } },
          { returnDocument: 'before', session },
        );
        if (!o) return;
        const eid = String(o.enterpriseId);
        let stockIssue = false;
        const wasCancelled = o.status === 'cancelled';
        if (o.stockReleased) {
          for (const i of o.items) {
            if (i.stockTracked === false) continue;
            try { await this.products.decreaseQuantity(eid, String(i.productId), i.quantity, session); } catch { stockIssue = true; }
          }
        }
        const sale = await this.sales.recordOnlineSale(eid, { orderId: o._id, items: o.items, totalCents: o.subtotalCents, rateBps: o.feeRateBps ?? 0, collectedFeeCents: info.feeCents }, session);
        await this.orders.updateOne({ _id: o._id }, { $set: { saleId: sale._id, feeCents: sale.feeCents, feeCharged: true, stockReleased: false, stockIssue, ...(wasCancelled ? { refundNeeded: true } : {}) } }, { session });
        changed = true;
      });
      if (changed) order = await this.orders.findById(id);
    } finally {
      await session.endSession();
    }
    if (order) void this.notifyPaid(order);
    return changed;
  }

  private async notifyPaid(o: OrderDocument) {
    try {
      const link = this.front ? `${this.front}/app/pedidos?id=${o._id}` : '';
      const ent = await this.stores.getOrCreate(String(o.enterpriseId));
      const owner = await this.enterprises.findEnterpriseById(String(o.enterpriseId)).catch(() => null);
      const lines = o.items.map((i) => `- ${i.quantity}x ${i.productName} (${fmt(i.totalCents)})`).join('\n');
      if (owner?.email) await this.mail.send(owner.email, `Novo pedido pago #${o.number} - ${fmt(o.totalCents)}`, `Pedido #${o.number} pago na loja ${ent.name}.\n\n${lines}\nEntrega: ${o.shipping.name} (${fmt(o.shipping.priceCents)})\nCliente: ${o.customer.name} - ${o.customer.phone}\n\n${link}`);
      await this.mail.send(o.customer.email, `Pagamento confirmado - pedido #${o.number}`, `Olá, ${o.customer.name.split(' ')[0]}! Recebemos o pagamento do seu pedido #${o.number} na ${ent.name}.\n\n${lines}\nTotal: ${fmt(o.totalCents)}\n\nVocê pode acompanhar o pedido pelo link que abriu depois do pagamento.`);
    } catch (e) {
      this.logger.warn(`Aviso do pedido ${o._id} não enviado: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ painel do lojista

  async list(eid: string, q: OrderListQueryDto) {
    const filter: Record<string, unknown> = { enterpriseId: new Types.ObjectId(eid) };
    if (!q.status || q.status === 'open') filter.status = { $in: ['paid', 'preparing', 'ready_for_pickup', 'shipped'] };
    else if (q.status === 'all') filter.status = { $nin: ['expired'] };
    else filter.status = q.status;
    if (q.search?.trim()) {
      const s = q.search.trim().replace(/^#/, '');
      const rx = { $regex: escapeRegex(s.slice(0, 60)), $options: 'i' };
      filter.$or = [{ 'customer.name': rx }, { 'customer.email': rx }, { 'customer.phone': rx }, ...(/^\d+$/.test(s) ? [{ number: Number(s) }] : [])];
    }
    const [rows, total] = await Promise.all([
      this.orders.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.orders.countDocuments(filter),
    ]);
    return { items: rows.map((o) => this.present(o)), total, page: q.page, limit: q.limit };
  }

  async summary(eid: string) {
    const rows = await this.orders.aggregate<{ _id: OrderStatus; n: number }>([
      { $match: { enterpriseId: new Types.ObjectId(eid) } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r._id, r.n])) as Partial<Record<OrderStatus, number>>;
    const unseen = await this.orders.countDocuments({ enterpriseId: new Types.ObjectId(eid), status: 'paid', seen: false });
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [rev] = await this.orders.aggregate<{ cents: number; n: number; fee: number }>([
      { $match: { enterpriseId: new Types.ObjectId(eid), status: { $in: ['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'] }, 'payment.paidAt': { $gte: since } } },
      { $group: { _id: null, cents: { $sum: '$totalCents' }, n: { $sum: 1 }, fee: { $sum: '$feeCents' } } },
    ]);
    return {
      byStatus: by, unseen,
      open: (by.paid ?? 0) + (by.preparing ?? 0) + (by.ready_for_pickup ?? 0) + (by.shipped ?? 0),
      last30: { cents: rev?.cents ?? 0, orders: rev?.n ?? 0, feeCents: rev?.fee ?? 0 },
    };
  }

  async get(eid: string, id: string) {
    const o = await this.orders.findOneAndUpdate({ _id: id, enterpriseId: eid }, { $set: { seen: true } }, { returnDocument: 'after' });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    return this.present(o);
  }

  async setStatus(eid: string, id: string, dto: OrderStatusDto) {
    const o = await this.orders.findOne({ _id: id, enterpriseId: eid });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    if (!canMove(o.status, dto.status, o.shipping.kind)) throw new ConflictException(`Não dá para mudar de "${ORDER_STATUS_LABEL[o.status]}" para "${ORDER_STATUS_LABEL[dto.status]}"`);
    const set: Record<string, unknown> = { status: dto.status, seen: true };
    if (dto.status === 'shipped') {
      const code = dto.trackingCode?.trim().toUpperCase() ?? '';
      set['tracking.code'] = code;
      set['tracking.url'] = dto.trackingUrl?.trim() || (code ? trackingUrlFor(code) ?? '' : '');
    }
    const r = await this.orders.findOneAndUpdate(
      { _id: o._id, status: o.status }, // corrida entre duas abas: só a primeira muda
      { $set: set, $push: { history: { status: dto.status, at: new Date(), note: dto.note?.trim() || undefined } } },
      { returnDocument: 'after' },
    );
    if (!r) throw new ConflictException('O pedido mudou enquanto você editava. Atualize a página.');
    if (dto.status === 'shipped' || dto.status === 'ready_for_pickup') void this.notifyCustomer(r);
    return this.present(r);
  }

  private async notifyCustomer(o: OrderDocument) {
    const msg = o.status === 'shipped'
      ? `Seu pedido #${o.number} foi enviado (${o.shipping.name}).${o.tracking?.code ? `\nCódigo de rastreio: ${o.tracking.code}` : ''}${o.tracking?.url ? `\n${o.tracking.url}` : ''}`
      : `Seu pedido #${o.number} está pronto para retirada.`;
    await this.mail.send(o.customer.email, `Pedido #${o.number}: ${ORDER_STATUS_LABEL[o.status]}`, msg).catch(() => undefined);
  }

  /** Cancela. Pago: desfaz a venda (estoque, promoção e taxa) e marca que o lojista precisa devolver o dinheiro. */
  async cancel(eid: string, id: string, dto: OrderCancelDto) {
    const o = await this.orders.findOne({ _id: id, enterpriseId: eid });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    if (!canCancel(o.status)) throw new ConflictException('Esse pedido não pode mais ser cancelado');
    if (o.status === 'pending_payment') {
      await this.release(o._id, 'cancelled', dto.reason);
    } else {
      // Devolve o dinheiro ao comprador pelo Mercado Pago (a comissão do Balcão volta junto). Falhou: o lojista devolve na mão.
      let refunded = false;
      if (o.payment?.paymentId) {
        try { await this.mp.refund(o.payment.paymentId, await this.stores.mpAccessToken(o.storeId), `refund-${o._id}`); refunded = true; }
        catch (e) { this.logger.warn(`Estorno automático do pedido ${o._id} falhou: ${(e as Error).message}`); }
      }
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          const r = await this.orders.findOneAndUpdate(
            { _id: o._id, status: o.status },
            { $set: { status: 'cancelled', cancelReason: dto.reason.trim(), refundNeeded: !refunded, stockReleased: true, ...(refunded ? { 'payment.refundedAt': new Date(), feeCents: 0 } : {}) }, $push: { history: { status: 'cancelled', at: new Date(), note: dto.reason.trim() } } },
            { session },
          );
          if (!r) throw new ConflictException('O pedido mudou enquanto você editava. Atualize a página.');
          if (o.saleId) await this.sales.cancel(eid, String(o.saleId), { fromOrder: true, session });
        });
      } finally {
        await session.endSession();
      }
      if (refunded && o.saleId) await this.billing.reverseCollectedFee(o.saleId).catch(() => undefined);
    }
    return this.present((await this.orders.findById(o._id))!);
  }

  /** Devolve a reserva de um pedido não pago (expirou ou foi cancelado). Idempotente. */
  async release(id: Types.ObjectId, status: 'expired' | 'cancelled', reason?: string): Promise<boolean> {
    const session = await this.connection.startSession();
    let done = false;
    try {
      await session.withTransaction(async () => {
        done = false;
        const o = await this.orders.findOneAndUpdate(
          { _id: id, status: 'pending_payment', stockReleased: false },
          { $set: { status, stockReleased: true, ...(reason ? { cancelReason: reason } : {}) }, $push: { history: { status, at: new Date(), note: reason } } },
          { session },
        );
        if (!o) return;
        const eid = String(o.enterpriseId);
        for (const i of o.items) {
          if (i.promotionId) await this.promotions.release(i.promotionId, i.quantity, session);
          if (i.stockTracked !== false) await this.products.increaseQuantity(eid, String(i.productId), i.quantity, session);
        }
        done = true;
      });
    } finally {
      await session.endSession();
    }
    return done;
  }

  /** Rotina: pedidos sem pagamento depois do prazo devolvem o estoque. */
  async expireStale(now = new Date()): Promise<number> {
    const stale = await this.orders.find({ status: 'pending_payment', expiresAt: { $lt: now } }).select('_id').limit(200).lean();
    let n = 0;
    for (const s of stale) if (await this.release(s._id as Types.ObjectId, 'expired')) n++;
    return n;
  }

  // ------------------------------------------------------------------ saída

  present(o: OrderDocument, isPublic = false) {
    const j = o.toJSON() as Record<string, any>;
    delete j.accessHash; delete j.payeeId; delete j.__v;
    const base = {
      id: String(o._id), number: o.number, status: o.status, statusLabel: ORDER_STATUS_LABEL[o.status], createdAt: j.createdAt,
      items: o.items.map((i) => ({ productId: String(i.productId), name: i.productName, code: i.productCode, quantity: i.quantity, unitPriceCents: i.unitPriceCents, originalUnitPriceCents: i.originalUnitPriceCents, totalCents: i.totalCents, promo: !!i.promotionId })),
      subtotalCents: o.subtotalCents, shipping: o.shipping, totalCents: o.totalCents, tracking: o.tracking, history: o.history,
      expiresAt: o.expiresAt, checkoutUrl: o.status === 'pending_payment' ? o.payment?.checkoutUrl ?? null : null,
      paidAt: o.payment?.paidAt ?? null, address: o.address, customer: { name: o.customer.name },
    };
    if (isPublic) return base;
    return {
      ...base, customer: o.customer, notes: o.notes, payment: { provider: 'mercadopago', method: o.payment?.method ?? null, paymentId: o.payment?.paymentId ?? null, paidAmountCents: o.payment?.paidAmountCents ?? null, refundedAt: o.payment?.refundedAt ?? null },
      fee: { source: o.source ?? 'store', rateBps: o.feeRateBps ?? 0, cents: o.feeCents ?? 0, charged: !!o.feeCharged },
      stockIssue: o.stockIssue, refundNeeded: o.refundNeeded, cancelReason: o.cancelReason, seen: o.seen, saleId: o.saleId ? String(o.saleId) : null,
    };
  }
}

