import { phoneIndex } from '../common/security/field-crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { CustomerService } from '../customer/customer.service';
import { ShopperService, fmtAddress } from '../shopper/shopper.service';
import type { ShopperDocument } from '../shopper/schema/shopper.schema';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, ClientSession } from 'mongoose';
import { Order, OrderDocument } from './schema/order.schema';
import { StoreDocument } from './schema/store.schema';
import { CheckoutDto, CollectDto, OrderCancelDto, OrderListQueryDto, OrderStatusDto } from './dto/order.dto';
import { PricedLine, StoreService } from './store.service';
import { open as openSealed, randomToken, seal, sha256, sign, verifySigned } from '../common/secret-box';
import { EmailCodeService } from './email-code.service';
import { autoConfirmOf, graceEnd, shipByOf } from './protection';
import { canCancel, canMove, isPaidLike, modeOf, PAY_ON_DELIVERY_LABEL, ORDER_STATUS_LABEL, PAYMENT_WINDOW_MIN, trackingUrlFor, type OrderStatus } from './store.rules';
import { ProductService } from '../products/product.service';
import { onlineEffectivePrice } from '../products/schema/product.schema';
import { PromotionService } from '../promotion/promotion.service';
import { SaleService } from '../sale/sale.service';
import { SaleItem } from '../sale/schema/sale.schema';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { BillingService, onlineFeeCents } from '../billing/billing.service';
import { feeWaived } from '../billing/billing.rules';
import { MailService } from '../mail/mail.service';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { toCents } from '../common/money';
import { escapeRegex } from '../common/mongo';
import { RewardsService } from './rewards.service';
import { cashbackCents, creditToUse } from './rewards.rules';
import { crossTenant } from '../common/security/tenant-guard.plugin';

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
    private readonly customers: CustomerService,
    private readonly shoppers: ShopperService,
    private readonly rewards: RewardsService,
  ) {}

  /** Valor dos produtos que o cliente realmente pagou (subtotal menos cupom e crédito de cashback). */
  private goodsOf(o: { subtotalCents: number; discount?: { couponCents?: number; creditCents?: number } | null }) {
    return Math.max(0, o.subtotalCents - (o.discount?.couponCents ?? 0) - (o.discount?.creditCents ?? 0));
  }

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
      const normal = toCents(onlineEffectivePrice(p)); // preço da loja online (pode ser diferente do balcão)
      const pr = promos.get(String(p._id));
      const unit = pr && pr.promoPriceCents < normal ? pr.promoPriceCents : normal;
      return { productId: String(p._id), name: p.name, quantity: qty.get(String(p._id))!, unitCents: unit, dims: p };
    });
  }

  async quote(slug: string, cep: string, items: { productId: string; quantity: number }[], preview?: string) {
    const { store } = await this.stores.publicBySlug(slug, { preview });
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
  async checkout(slug: string, dto: CheckoutDto, shopper: ShopperDocument | null = null, ip = '') {
    const { store } = await this.stores.publicBySlug(slug, { forOrder: true });
    if (!store.mp?.userId) throw new ConflictException('Esta loja ainda não configurou o pagamento');
    const eid = String(store.enterpriseId);

    // Frete recalculado no servidor para a opção escolhida.
    const preview = await this.priceCart(store, dto.items);
    const options = await this.stores.quote(store, dto.address?.cep ?? null, preview);
    const ship = options.find((o) => o.id === dto.shippingOptionId);
    if (!ship) throw new UnprocessableEntityException('Forma de entrega indisponível para esse endereço. Calcule o frete de novo.');
    // Sem conta: o e-mail precisa ter sido confirmado com código (o comprovante e o acompanhamento vão para ele).
    // Pedido de mesa é entregue na hora, dentro do bar: não pede código (só atrasaria quem está sentado esperando).
    const emailOk = shopper ? shopper.email.toLowerCase() === dto.customer.email.trim().toLowerCase() || EmailCodeService.valid(dto.customer.email, dto.emailToken) : EmailCodeService.valid(dto.customer.email, dto.emailToken);
    if (!emailOk && ship.kind !== 'table') throw new UnprocessableEntityException({ statusCode: 422, code: 'EMAIL_NOT_VERIFIED', message: 'Confirme seu e-mail com o código que enviamos antes de pagar.' });
    const noAddress = ship.kind === 'pickup' || ship.kind === 'table';
    if (!noAddress && !dto.address) throw new BadRequestException('Informe o endereço de entrega');
    // Pagar na entrega/retirada: só se a loja aceita (cardápio e loja virtual) e na entrega própria ou retirada.
    const cod = dto.payOnDelivery ?? null;
    if (cod) {
      const pod = store.payOnDelivery;
      if (modeOf(store) === 'ecommerce' || !pod?.enabled || !pod.methods?.includes(cod.method)) throw new UnprocessableEntityException('Esta loja não aceita essa forma de pagamento na entrega');
      if (!['local', 'pickup'].includes(ship.kind)) throw new UnprocessableEntityException('Pagar na entrega só vale para a entrega da loja ou retirada');
    }
    let table: number | null = null;
    if (ship.kind === 'table') {
      const max = store.tables?.count || 0;
      if (!dto.table || dto.table > max) throw new UnprocessableEntityException(`Escolha a ${(store.tables?.label || 'mesa').toLowerCase()} (de 1 a ${max})`);
      table = dto.table;
      ship.name = `${store.tables?.label || 'Mesa'} ${table}`;
    }

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
          const normal = toCents(onlineEffectivePrice(p)); // preço da loja online (pode ser diferente do balcão)
          const base = { productId: p._id as Types.ObjectId, productName: p.name, productCode: p.code, originalUnitPriceCents: Math.max(toCents(p.price), normal), stockTracked: r.tracked };
          const pr = promos.get(l.productId);
          const promoQty = pr && pr.promoPriceCents < normal ? await this.promotions.consume(pr, l.quantity, session) : 0;
          if (promoQty > 0) items.push({ ...base, unitPriceCents: pr!.promoPriceCents, quantity: promoQty, totalCents: pr!.promoPriceCents * promoQty, promotionId: pr!._id });
          if (l.quantity - promoQty > 0) items.push({ ...base, unitPriceCents: normal, quantity: l.quantity - promoQty, totalCents: normal * (l.quantity - promoQty) });
        }
        const subtotalCents = items.reduce((s, i) => s + i.totalCents, 0);
        if (store.minOrderCents && subtotalCents < store.minOrderCents) throw new UnprocessableEntityException(`Pedido mínimo desta loja: ${fmt(store.minOrderCents)}`);
        // Descontos (só sobre os produtos). Online, sobra pelo menos R$ 1,00 para pagar: o Mercado Pago não cobra zero.
        const minPay = cod ? 0 : Math.max(0, 100 - ship.priceCents);
        let couponCents = 0, couponId: Types.ObjectId | null = null, couponCode = '';
        if (dto.couponCode?.trim()) {
          const c = await this.rewards.consumeCoupon(eid, dto.couponCode, subtotalCents, dto.customer.email, session);
          couponCents = Math.min(c.discountCents, Math.max(0, subtotalCents - minPay)); couponId = c.couponId; couponCode = c.code;
        }
        let creditCents = 0;
        if (dto.useCredit) {
          if (!shopper) throw new UnprocessableEntityException({ statusCode: 422, code: 'LOGIN_REQUIRED', message: 'Entre na sua conta para usar o cashback' });
          creditCents = creditToUse(await this.rewards.balance(shopper._id, eid, session), Math.max(0, subtotalCents - couponCents - minPay));
          if (creditCents > 0) await this.rewards.spendCredit(shopper._id, eid, orderId, creditCents, session);
        }
        const goodsCents = subtotalCents - couponCents - creditCents;
        const cb = shopper ? await this.rewards.cashbackOf(eid, session) : null;
        const number = await this.stores.nextOrderNumber(store._id, session);
        // Comprador logado: vira (ou já é) cliente desta loja, em "Clientes" do lojista.
        const customer = shopper
          ? await this.customers.ensureForShopper(eid, { _id: shopper._id, name: shopper.name, email: shopper.email, phone: dto.customer.phone || shopper.phone }, dto.address && !noAddress ? fmtAddress(dto.address) : '', session)
          : null;
        const now = new Date();
        const status = cod ? 'confirmed' : 'pending_payment';
        [order] = await this.orders.create([{
          _id: orderId, enterpriseId: store.enterpriseId, storeId: store._id, storeSlug: store.slug, number, status,
          items, subtotalCents, totalCents: goodsCents + ship.priceCents,
          discount: { couponId, couponCode, couponCents, creditCents }, cashbackCents: cb ? cashbackCents(goodsCents, cb.rateBps) : 0,
          shipping: { optionId: ship.id, kind: ship.kind, name: ship.name, carrier: ship.carrier, priceCents: ship.priceCents, etaText: ship.etaText },
          customer: { name: dto.customer.name.trim(), email: dto.customer.email.trim().toLowerCase(), phone: dto.customer.phone, document: dto.customer.document || undefined },
          address: noAddress ? null : { ...dto.address!, state: dto.address!.state.toUpperCase() }, table, mode: modeOf(store),
          shopperId: shopper?._id ?? null, customerId: customer?._id ?? null,
          consent: { acceptedAt: now, termsVersion: dto.termsVersion ?? '', ip: ip.slice(0, 64) }, emailVerified: emailOk,
          notes: dto.notes?.trim() ?? '', provider: 'mercadopago', payeeId: store.mp.userId, accessHash: sha256(token),
          source, feeRateBps, feeCents: waived ? 0 : onlineFeeCents(goodsCents, feeRateBps), feeCharged: false,
          expiresAt: new Date(now.getTime() + (cod ? 30 * 86_400_000 : PAYMENT_WINDOW_MIN * 60_000)), history: [{ status, at: now }], seen: !cod,
          payment: { checkoutUrl: null, preferenceId: null, paymentId: null, method: null, paidAmountCents: null, paidAt: null, refundedAt: null, mode: cod ? 'on_delivery' : 'online', onDelivery: cod ? { method: cod.method, changeForCents: cod.method === 'cash' ? cod.changeForCents ?? null : null } : null },
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    if (shopper) await this.shoppers.rememberCheckout(shopper, dto.customer, !noAddress ? dto.address ?? null : null).catch(() => undefined);

    if (cod) {
      const link = `${this.front}/loja/${store.slug}/pedido/${String(order._id)}?t=${token}`;
      await this.orders.updateOne({ _id: order._id }, { $set: { linkSealed: seal(link) } });
      void this.notifyCod(order, store.name, link);
      return { orderId: String(order._id), number: order.number, token, checkoutUrl: null, totalCents: order.totalCents };
    }

    // Pagamento fora da transação (chamada externa). Se falhar, devolve a reserva.
    try {
      const oid = String(order._id);
      const accessToken = await this.stores.mpAccessToken(store._id);
      const pref = await this.mp.createPreference({
        accessToken, orderId: oid, marketplaceFeeCents: order.feeCents, expiresAt: order.expiresAt, statementDescriptor: store.name,
        // Com cupom ou cashback, vai uma linha só com o total (o Mercado Pago não aceita item negativo de desconto).
        items: order.totalCents !== order.subtotalCents + order.shipping.priceCents
          ? [{ title: `Pedido #${order.number} - ${store.name}`, quantity: 1, unitCents: order.totalCents }]
          : [
            ...order.items.map((i) => ({ title: i.productName, quantity: i.quantity, unitCents: i.unitPriceCents })),
            ...(order.shipping.priceCents > 0 ? [{ title: `Frete - ${order.shipping.name}`, quantity: 1, unitCents: order.shipping.priceCents }] : []),
          ],
        payer: { name: order.customer.name, email: order.customer.email, phone: order.customer.phone, document: order.customer.document, address: order.address },
        maxInstallments: store.theme?.installments ?? 0,
        backUrl: `${this.front}/loja/${store.slug}/pedido/${oid}?t=${token}`,
        notificationUrl: this.api.startsWith('https://') ? `${this.api}/public/store-webhook/mercadopago?o=${oid}&s=${sign(SCOPE, oid)}` : undefined,
      });
      const link = `${this.front}/loja/${store.slug}/pedido/${oid}?t=${token}`;
      await this.orders.updateOne({ _id: order._id }, { $set: { 'payment.checkoutUrl': pref.initPoint, 'payment.preferenceId': pref.id, linkSealed: seal(link) } });
      void this.mail.send(order.customer.email, `Pedido #${order.number} recebido - ${store.name}`,
        `Olá, ${order.customer.name.split(' ')[0]}! Seu pedido #${order.number} na ${store.name} foi criado.\n\n${order.items.map((i) => `- ${i.quantity}x ${i.productName} (${fmt(i.totalCents)})`).join('\n')}\nTotal: ${fmt(order.totalCents)}\n\nSe ainda não pagou, pague por aqui (vale por 1 hora): ${pref.initPoint}\nAcompanhe o pedido: ${link}\n\nGuarde este e-mail: o link acima é o acesso ao seu pedido, sem precisar de cadastro.`).catch(() => undefined);
      return { orderId: oid, number: order.number, token, checkoutUrl: pref.initPoint, totalCents: order.totalCents };
    } catch (e) {
      await this.release(order._id, 'cancelled', 'Falha ao gerar o pagamento').catch((err) => this.logger.error(`Reserva presa no pedido ${order._id}: ${err.message}`));
      throw e;
    }
  }

  // ------------------------------------------------------------------ acompanhamento (público)

  async byToken(slug: string, id: string, t: string): Promise<OrderDocument> {
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
    // O pedido vem da URL assinada do webhook (token por pedido); o pagamento é reconsultado no Mercado Pago.
    const o = await crossTenant(this.orders, 'webhook: pedido identificado pela URL assinada').findById(oid);
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
          if (r) await this.undoRewards(o, session);
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
        // Pago depois de expirar: o crédito usado tinha voltado para o cliente, então é usado de novo.
        if (o.stockReleased) await this.rewards.respendIfNeeded(o.shopperId, eid, o._id, o.discount?.creditCents ?? 0, session);
        const sale = await this.sales.recordOnlineSale(eid, { orderId: o._id, items: o.items, totalCents: this.goodsOf(o), rateBps: o.feeRateBps ?? 0, collectedFeeCents: info.feeCents, customerId: o.customerId ?? null }, session);
        await this.giveCashback(o, eid, session);
        // Compra protegida: a loja tem um prazo para enviar (pedido na mesa fica de fora).
        const mode = o.mode ?? 'ecommerce'; const shipBy = shipByOf(o.shipping.kind, now, mode);
        const protection = o.shipping.kind !== 'table' ? { protection: { status: 'active', mode, shipBy, graceAt: graceEnd(shipBy, mode), warnedAt: null, autoConfirmAt: null, confirmedAt: null, confirmedBy: '' } } : {};
        await this.orders.updateOne({ _id: o._id }, { $set: { saleId: sale._id, feeCents: sale.feeCents, feeCharged: true, stockReleased: false, stockIssue, ...protection, ...(wasCancelled ? { refundNeeded: true } : {}) } }, { session });
        changed = true;
      });
      if (changed) order = await this.orders.findById(id);
    } finally {
      await session.endSession();
    }
    if (order) void this.notifyPaid(order);
    return changed;
  }

  /** Pedido para pagar na entrega: avisa a loja (pedido novo) e o cliente (resumo + link). */
  private async notifyCod(o: OrderDocument, storeName: string, link: string) {
    try {
      const lines = o.items.map((i) => `- ${i.quantity}x ${i.productName} (${fmt(i.totalCents)})`).join('\n');
      const pay = o.payment.onDelivery ? `${PAY_ON_DELIVERY_LABEL[o.payment.onDelivery.method as 'cash']}${o.payment.onDelivery.changeForCents ? ` (troco para ${fmt(o.payment.onDelivery.changeForCents)})` : ''}` : '';
      const owner = await this.enterprises.findEnterpriseById(String(o.enterpriseId)).catch(() => null);
      if (owner?.email) await this.mail.send(owner.email, `Novo pedido #${o.number} - pagar na entrega - ${fmt(o.totalCents)}`, `Pedido #${o.number} na loja ${storeName}.\n\n${lines}\n${o.shipping.name}: ${fmt(o.shipping.priceCents)}\nTotal: ${fmt(o.totalCents)}\nPagamento na entrega: ${pay}\nCliente: ${o.customer.name} - ${o.customer.phone}\n\n${this.front}/app/pedidos?id=${o._id}`);
      await this.mail.send(o.customer.email, `Pedido #${o.number} confirmado - ${storeName}`, `Olá, ${o.customer.name.split(' ')[0]}! Seu pedido #${o.number} foi confirmado.\n\n${lines}\n${o.shipping.name}: ${o.shipping.priceCents ? fmt(o.shipping.priceCents) : 'grátis'}\nTotal: ${fmt(o.totalCents)}\n\nVocê paga ${o.shipping.kind === 'pickup' ? 'na retirada' : 'na entrega'}: ${pay}.\nAcompanhe: ${link}`);
    } catch (e) { this.logger.warn(`Aviso do pedido ${o._id} não enviado: ${(e as Error).message}`); }
  }

  /** Entregue e pago na entrega: registra como foi pago, vira venda e a taxa da loja online entra na fatura. */
  async collect(eid: string, id: string, dto: CollectDto) {
    const o = await this.orders.findOne({ _id: id, enterpriseId: eid });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    if (o.payment?.mode !== 'on_delivery') throw new ConflictException('Este pedido já foi pago online');
    if (o.saleId || o.status === 'delivered') throw new ConflictException('Recebimento já registrado');
    if (!['confirmed', 'preparing', 'ready_for_pickup', 'shipped'].includes(o.status)) throw new ConflictException('Esse pedido não está aberto');
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const r = await this.orders.findOneAndUpdate({ _id: o._id, status: o.status, saleId: null }, { $set: { status: 'delivered', seen: true, 'payment.method': dto.method, 'payment.paidAmountCents': o.totalCents, 'payment.paidAt': now }, $push: { history: { status: 'delivered', at: now, note: `Pago na ${o.shipping.kind === 'pickup' ? 'retirada' : 'entrega'}: ${PAY_ON_DELIVERY_LABEL[dto.method as 'cash'] ?? 'Outro'}` } } }, { session });
        if (!r) throw new ConflictException('O pedido mudou enquanto você editava. Atualize a página.');
        await this.giveCashback(o, eid, session);
        const sale = await this.sales.recordCodSale(eid, { orderId: o._id, items: o.items, subtotalCents: this.goodsOf(o), orderTotalCents: o.totalCents, rateBps: o.feeRateBps ?? 0, paymentMethod: dto.method, cashReceivedCents: dto.method === 'cash' ? dto.cashReceivedCents ?? null : null, customerId: o.customerId ?? null }, session);
        await this.orders.updateOne({ _id: o._id }, { $set: { saleId: sale._id, feeCents: sale.feeCents, feeCharged: true } }, { session });
      });
    } finally {
      await session.endSession();
    }
    return this.present((await this.orders.findById(o._id))!);
  }

  private async notifyPaid(o: OrderDocument) {
    try {
      const link = this.front ? `${this.front}/app/pedidos?id=${o._id}` : '';
      const ent = await this.stores.getOrCreate(String(o.enterpriseId));
      const owner = await this.enterprises.findEnterpriseById(String(o.enterpriseId)).catch(() => null);
      const lines = o.items.map((i) => `- ${i.quantity}x ${i.productName} (${fmt(i.totalCents)})`).join('\n');
      if (owner?.email) await this.mail.send(owner.email, `Novo pedido pago #${o.number} - ${fmt(o.totalCents)}`, `Pedido #${o.number} pago na loja ${ent.name}.\n\n${lines}\nEntrega: ${o.shipping.name} (${fmt(o.shipping.priceCents)})\nCliente: ${o.customer.name} - ${o.customer.phone}\n\n${link}`);
      const sealed = (await this.orders.findById(o._id).select('+linkSealed').lean())?.linkSealed;
      const track = openSealed(sealed) ?? '';
      const l = (ent as { legal?: { name?: string; document?: string } }).legal;
      await this.mail.send(o.customer.email, `Compra confirmada - pedido #${o.number} - ${ent.name}`,
        `Olá, ${o.customer.name.split(' ')[0]}! Recebemos o pagamento do seu pedido #${o.number} na ${ent.name}.\n\n` +
        `COMPROVANTE DE COMPRA (não é documento fiscal)\nPedido #${o.number} · ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n${lines}\n` +
        `${o.shipping.name}: ${o.shipping.priceCents ? fmt(o.shipping.priceCents) : 'grátis'}\nTotal pago: ${fmt(o.totalCents)}\n` +
        `Vendido por: ${l?.name || ent.name}${l?.document ? ` · ${l.document}` : ''}\n\n` +
        `${track ? `Acompanhe o pedido, confirme o recebimento ou relate um problema: ${track}\n\n` : ''}` +
        `Compra protegida: se o produto não chegar, avise pelo link acima. O pagamento foi processado pelo Mercado Pago.`);
    } catch (e) {
      this.logger.warn(`Aviso do pedido ${o._id} não enviado: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ painel do lojista

  async list(eid: string, q: OrderListQueryDto) {
    const filter: Record<string, unknown> = { enterpriseId: new Types.ObjectId(eid) };
    if (!q.status || q.status === 'open') filter.status = { $in: ['confirmed', 'paid', 'preparing', 'ready_for_pickup', 'shipped'] };
    else if (q.status === 'all') filter.status = { $nin: ['expired'] };
    else if (q.status === 'to_ship') filter.status = { $in: ['confirmed', 'paid', 'preparing'] };
    else if (q.status === 'late') { filter.status = { $in: ['paid', 'preparing'] }; filter['protection.shipBy'] = { $lt: new Date() }; }
    else if (q.status === 'dispute') filter['dispute.status'] = 'open';
    else if (q.status === 'to_print') { filter['label.status'] = 'generated'; filter['label.printedAt'] = null; }
    else filter.status = q.status;
    if (q.search?.trim()) {
      const s = q.search.trim().replace(/^#/, '');
      const rx = { $regex: escapeRegex(s.slice(0, 60)), $options: 'i' };
      // Telefone é criptografado: acha pelo índice cego (número completo, 8+ dígitos), não por pedaço.
      const pidx = phoneIndex(s);
      filter.$or = [{ 'customer.name': rx }, { 'customer.email': rx }, ...(pidx ? [{ 'customer.phoneIdx': pidx }] : []), ...(/^\d+$/.test(s) ? [{ number: Number(s) }] : [])];
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
    const unseen = await this.orders.countDocuments({ enterpriseId: new Types.ObjectId(eid), status: { $in: ['paid', 'confirmed'] }, seen: false });
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [rev] = await this.orders.aggregate<{ cents: number; n: number; fee: number }>([
      { $match: { enterpriseId: new Types.ObjectId(eid), status: { $in: ['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'] }, 'payment.paidAt': { $gte: since } } },
      { $group: { _id: null, cents: { $sum: '$totalCents' }, n: { $sum: 1 }, fee: { $sum: '$feeCents' } } },
    ]);
    const eoid = new Types.ObjectId(eid);
    const [late, disputes, toPrint] = await Promise.all([
      this.orders.countDocuments({ enterpriseId: eoid, status: { $in: ['paid', 'preparing'] }, 'protection.shipBy': { $lt: new Date() } }),
      this.orders.countDocuments({ enterpriseId: eoid, 'dispute.status': 'open' }),
      this.orders.countDocuments({ enterpriseId: eoid, 'label.status': 'generated', 'label.printedAt': null }),
    ]);
    return {
      byStatus: by, unseen,
      logistics: { toShip: (by.confirmed ?? 0) + (by.paid ?? 0) + (by.preparing ?? 0), late, disputes, toPrint, inTransit: by.shipped ?? 0, readyForPickup: by.ready_for_pickup ?? 0 },
      open: (by.confirmed ?? 0) + (by.paid ?? 0) + (by.preparing ?? 0) + (by.ready_for_pickup ?? 0) + (by.shipped ?? 0),
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
    if (dto.status === 'delivered' && o.payment?.mode === 'on_delivery' && !o.saleId) throw new ConflictException('Registre como o cliente pagou: use "Entregue e pago".');
    if (!canMove(o.status, dto.status, o.shipping.kind)) throw new ConflictException(`Não dá para mudar de "${ORDER_STATUS_LABEL[o.status]}" para "${ORDER_STATUS_LABEL[dto.status]}"`);
    const set: Record<string, unknown> = { status: dto.status, seen: true };
    if (dto.status === 'delivered' && o.protection?.status === 'active') set['protection.autoConfirmAt'] = autoConfirmOf(new Date(), o.protection.mode ?? o.mode ?? 'ecommerce');
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

  async notifyCustomer(o: OrderDocument) {
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
    if (o.status === 'pending_payment' || (o.payment?.mode === 'on_delivery' && !o.saleId)) {
      // Não pago (ou paga na entrega e ainda não recebido): só devolve o estoque.
      await this.release(o._id, 'cancelled', dto.reason, [o.status]);
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
          await this.undoRewards(o, session);
        });
      } finally {
        await session.endSession();
      }
      if (refunded && o.saleId) await this.billing.reverseCollectedFee(o.saleId).catch(() => undefined);
    }
    return this.present((await this.orders.findById(o._id))!);
  }

  /** Pedido pago (online ou na entrega): o cashback vira crédito do comprador nesta loja. */
  private async giveCashback(o: { _id: Types.ObjectId; shopperId?: Types.ObjectId | null; cashbackCents?: number }, eid: string, session: ClientSession) {
    if (!o.shopperId || !o.cashbackCents) return;
    const cb = await this.rewards.cashbackOf(eid, session);
    await this.rewards.earn(o.shopperId, eid, o._id, o.cashbackCents, cb?.expiresDays ?? 90, session);
  }

  /** Pedido que não vingou (expirou, cancelado ou reembolsado): cupom e crédito usados voltam; cashback ganho deixa de valer. */
  private async undoRewards(o: { _id: Types.ObjectId; discount?: { couponId?: Types.ObjectId | null } | null }, session: ClientSession) {
    await this.rewards.releaseCoupon(o.discount?.couponId ?? null, session);
    await this.rewards.restoreCredit(o._id, session);
    await this.rewards.reverseEarn(o._id, session);
  }

  /** Devolve a reserva de um pedido não pago (expirou ou foi cancelado). Idempotente. */
  async release(id: Types.ObjectId, status: 'expired' | 'cancelled', reason?: string, from: OrderStatus[] = ['pending_payment']): Promise<boolean> {
    const session = await this.connection.startSession();
    let done = false;
    try {
      await session.withTransaction(async () => {
        done = false;
        const o = await this.orders.findOneAndUpdate(
          { _id: id, status: { $in: from }, stockReleased: false },
          { $set: { status, stockReleased: true, ...(reason ? { cancelReason: reason } : {}) }, $push: { history: { status, at: new Date(), note: reason } } },
          { session },
        );
        if (!o) return;
        const eid = String(o.enterpriseId);
        for (const i of o.items) {
          if (i.promotionId) await this.promotions.release(i.promotionId, i.quantity, session);
          if (i.stockTracked !== false) await this.products.increaseQuantity(eid, String(i.productId), i.quantity, session);
        }
        await this.undoRewards(o, session);
        done = true;
      });
    } finally {
      await session.endSession();
    }
    return done;
  }

  /** Rotina: pedidos sem pagamento depois do prazo devolvem o estoque. */
  async expireStale(now = new Date()): Promise<number> {
    const stale = await crossTenant(this.orders, 'rotina: expira pedidos não pagos de todas as lojas').find({ status: 'pending_payment', expiresAt: { $lt: now } }).select('_id').limit(200).lean();
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
      subtotalCents: o.subtotalCents, discount: { couponCode: o.discount?.couponCode ?? '', couponCents: o.discount?.couponCents ?? 0, creditCents: o.discount?.creditCents ?? 0 }, cashbackCents: o.cashbackCents ?? 0,
      shipping: o.shipping, totalCents: o.totalCents, tracking: o.tracking, history: o.history,
      expiresAt: o.expiresAt, checkoutUrl: o.status === 'pending_payment' ? o.payment?.checkoutUrl ?? null : null,
      paidAt: o.payment?.paidAt ?? null, address: o.address, table: o.table ?? null, customer: { name: o.customer.name },
      protection: o.protection ? { status: o.protection.status, shipBy: o.protection.shipBy, autoConfirmAt: o.protection.autoConfirmAt, confirmedAt: o.protection.confirmedAt } : null,
      dispute: o.dispute ? { status: o.dispute.status, reason: o.dispute.reason, message: o.dispute.message, openedAt: o.dispute.openedAt, sellerReply: o.dispute.sellerReply ?? '', sellerRepliedAt: o.dispute.sellerRepliedAt ?? null, escalatedAt: o.dispute.escalatedAt ?? null, resolvedAt: o.dispute.resolvedAt ?? null, note: o.dispute.note ?? '' } : null,
      refundedAt: o.payment?.refundedAt ?? null,
      payMode: o.payment?.mode ?? 'online', onDelivery: o.payment?.onDelivery?.method ? { method: o.payment.onDelivery.method, changeForCents: o.payment.onDelivery.changeForCents ?? null } : null,
      label: o.label && !isPublic ? { status: o.label.status, serviceName: o.label.serviceName ?? '', priceCents: o.label.priceCents ?? 0, trackingCode: o.label.trackingCode ?? '', error: o.label.error ?? '', printedAt: o.label.printedAt ?? null, protocol: o.label.protocol ?? '' } : null,
    };
    if (isPublic) return base;
    return {
      ...base, customer: { name: o.customer.name, email: o.customer.email, phone: o.customer.phone, ...(o.customer.document ? { document: o.customer.document } : {}) }, notes: o.notes, // sem o índice cego do telefone payment: { provider: 'mercadopago', method: o.payment?.method ?? null, paymentId: o.payment?.paymentId ?? null, paidAmountCents: o.payment?.paidAmountCents ?? null, refundedAt: o.payment?.refundedAt ?? null },
      fee: { source: o.source ?? 'store', rateBps: o.feeRateBps ?? 0, cents: o.feeCents ?? 0, charged: !!o.feeCharged },
      customerId: o.customerId ? String(o.customerId) : null, account: !!o.shopperId,
      stockIssue: o.stockIssue, refundNeeded: o.refundNeeded, cancelReason: o.cancelReason, seen: o.seen, saleId: o.saleId ? String(o.saleId) : null,
    };
  }
}

