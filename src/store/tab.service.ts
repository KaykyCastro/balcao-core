import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { storeUrl } from './domain.rules';
import { OptionsError, priceChoice, type OptionGroup, type PickedOption } from '../products/options.rules';
import { MP_PAYMENT_ID_RE } from '../mercadopago/mercadopago.client';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Tab, TabDocument, TabItem, type TabPay } from './schema/tab.schema';
import { StaffService } from '../staff/staff.service';
import { StoreDocument } from './schema/store.schema';
import { StoreService } from './store.service';
import { modeOf } from './store.rules';
import { ProductService } from '../products/product.service';
import { onlineEffectivePrice } from '../products/schema/product.schema';
import { PromotionService } from '../promotion/promotion.service';
import { SaleService } from '../sale/sale.service';
import type { Sale, SaleDocument, SaleItem } from '../sale/schema/sale.schema';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { randomToken, sha256, sign, verifySigned } from '../common/secret-box';
import { toCents } from '../common/money';
import { crossTenant } from '../common/security/tenant-guard.plugin';

const SCOPE = 'store-tab';
const MAX_OPEN_PER_TABLE = 12;
const MAX_ITEMS = 300;
const RECENT_MS = 4 * 3_600_000;

/** Quem da equipe fez a ação (funcionário logado). null = o dono. */
export type Who = { id: string; name: string; role?: string } | null;

export interface TabLine { productId: string; quantity: number; note?: string; options?: { g: string; i: string; q: number }[] }
type PayMethod = 'cash' | 'pix' | 'card' | 'other';

export function tabTotals(items: Pick<TabItem, 'status' | 'totalCents'>[], rateBps: number) {
  const subtotalCents = items.filter((i) => i.status !== 'cancelled').reduce((s, i) => s + i.totalCents, 0);
  const serviceCents = Math.round((subtotalCents * Math.max(0, rateBps)) / 10_000);
  return { subtotalCents, serviceCents, totalCents: subtotalCents + serviceCents };
}

/**
 * Comandas de mesa (modo cardápio). Cada mesa tem uma ou várias contas; o cliente pede pelo celular (QR Code da mesa)
 * e a equipe lança pelo painel. O pagamento só abre depois que a equipe libera a conta: aí o cliente paga pelo celular
 * (Mercado Pago do lojista) ou paga ao garçom (dinheiro, maquininha, Pix). Paga, a conta vira uma venda.
 */
@Injectable()
export class TabService {
  private readonly logger = new Logger(TabService.name);
  constructor(
    @InjectModel(Tab.name) private readonly tabs: Model<Tab>,
    @InjectConnection() private readonly connection: Connection,
    private readonly stores: StoreService,
    private readonly products: ProductService,
    private readonly promotions: PromotionService,
    private readonly sales: SaleService,
    private readonly mp: MercadoPagoClient,
    private readonly config: ConfigService,
    private readonly staff: StaffService,
  ) {}

  /** Garçom que mexe numa conta sem dono passa a ser o responsável por ela. */
  private claimSet(tab: { waiter?: { id: string } | null }, who: Who) {
    return who && who.role === 'waiter' && !tab.waiter?.id ? { waiter: { id: who.id, name: who.name } } : {};
  }

  private get api() { return (this.config.get<string>('APP_URL') ?? '').replace(/\/$/, ''); }
  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, ''); }

  private assertTabs(store: StoreDocument) {
    if (modeOf(store) !== 'menu' || !store.tables?.enabled || (store.tables.payment ?? 'tab') !== 'tab') throw new ConflictException('Esta loja não usa comanda na mesa');
  }
  private label(store: StoreDocument) { return store.tables?.label || 'Mesa'; }
  private checkTable(store: StoreDocument, table: number) {
    const max = store.tables?.count || 0;
    if (!Number.isInteger(table) || table < 1 || table > max) throw new UnprocessableEntityException(`${this.label(store)} inválida (de 1 a ${max})`);
  }
  private async run<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try { let out!: T; await session.withTransaction(async () => { out = await fn(session); }); return out; }
    finally { await session.endSession(); }
  }

  // ------------------------------------------------------------------ abrir conta

  private async create(store: StoreDocument, table: number, name: string, by: 'customer' | 'staff') {
    this.checkTable(store, table);
    const open = await this.tabs.countDocuments({ storeId: store._id, table, status: 'open' });
    if (open >= MAX_OPEN_PER_TABLE) throw new ConflictException(`Esta ${this.label(store).toLowerCase()} já tem ${open} contas abertas. Peça ajuda ao garçom.`);
    const token = randomToken();
    const number = await this.stores.nextTabNumber(store._id);
    const tab = await this.tabs.create({
      enterpriseId: store.enterpriseId, storeId: store._id, storeSlug: store.slug, number, table, name: name.trim().slice(0, 40) || `Conta ${number}`,
      status: 'open', items: [], serviceRateBps: store.tables?.serviceRateBps ?? 0, subtotalCents: 0, serviceCents: 0, totalCents: 0, call: null,
      payment: { released: false, releasedAt: null, releasedBy: '', amountCents: null, attempt: 0, checkoutUrl: null, preferenceId: null, paymentId: null, method: null, provider: null, paidAt: null, paidBy: '' },
      accessHash: sha256(token), openedBy: by,
    });
    return { tab, token };
  }

  async openPublic(slug: string, dto: { table: number; name: string }) {
    const { store } = await this.stores.publicBySlug(slug, { forOrder: true });
    this.assertTabs(store);
    if (!dto.name?.trim()) throw new BadRequestException('Diga um nome para a conta');
    const { tab, token } = await this.create(store, dto.table, dto.name, 'customer');
    return { token, tab: this.present(tab, store, true) };
  }

  async openStaff(eid: string, dto: { table: number; name?: string }, who: Who = null) {
    const store = await this.stores.getOrCreate(eid);
    this.assertTabs(store);
    const { tab } = await this.create(store, dto.table, dto.name ?? '', 'staff');
    const claim = this.claimSet(tab, who);
    if (claim.waiter) await this.tabs.updateOne({ _id: tab._id }, { $set: claim });
    return this.present((await this.tabs.findById(tab._id)) ?? tab, store);
  }

  // ------------------------------------------------------------------ acesso

  async byToken(slug: string, id: string, t: string): Promise<TabDocument> {
    if (!Types.ObjectId.isValid(id) || !t) throw new NotFoundException('Conta não encontrada');
    const tab = await this.tabs.findOne({ _id: id, storeSlug: String(slug).toLowerCase() }).select('+accessHash');
    if (!tab || tab.accessHash !== sha256(String(t))) throw new NotFoundException('Conta não encontrada');
    return tab;
  }
  private async mine(eid: string, id: string): Promise<TabDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Conta não encontrada');
    const tab = await this.tabs.findOne({ _id: id, enterpriseId: new Types.ObjectId(eid) });
    if (!tab) throw new NotFoundException('Conta não encontrada');
    return tab;
  }
  private async storeOf(tab: TabDocument) { return this.stores.getOrCreate(String(tab.enterpriseId)); }

  /** Cliente abre a conta pelo link. Voltando do Mercado Pago (payment_id), confere o pagamento na hora. */
  async publicView(slug: string, id: string, t: string, paymentId?: string) {
    let tab = await this.byToken(slug, id, t);
    if (paymentId && tab.status === 'open' && MP_PAYMENT_ID_RE.test(paymentId)) {
      await this.syncPayment(tab, paymentId).catch((e) => this.logger.warn(`Conferência da conta ${id}: ${(e as Error).message}`));
      tab = (await this.tabs.findById(tab._id))!;
    }
    return this.present(tab, await this.storeOf(tab), true);
  }

  // ------------------------------------------------------------------ itens

  /** Lança itens reservando estoque e promoção. Conta liberada para pagamento não aceita itens novos. */
  private async addLines(tab: TabDocument, lines: TabLine[], by: 'customer' | 'staff') {
    if (!lines.length) throw new BadRequestException('Nenhum item');
    const eid = String(tab.enterpriseId);
    const ids = [...new Set(lines.map((l) => l.productId))];
    // Cliente só pede o que está no cardápio online; a equipe lança qualquer produto (couvert, rolha...).
    const list = by === 'customer' ? await this.products.publicMany(eid, ids) : await Promise.all(ids.map((i) => this.products.getProductById(eid, i)));
    if (list.length !== ids.length) throw new UnprocessableEntityException('Algum item não está mais no cardápio. Atualize a página.');
    const byId = new Map(list.map((p) => [String(p._id), p]));
    // Mesma escolha (produto, adicionais e observação) vira uma linha só. Adicionais conferidos e precificados aqui.
    const qty = new Map<string, { pid: string; quantity: number; note: string; extra: number; options?: PickedOption[] }>();
    for (const l of lines) {
      const p = byId.get(l.productId)!;
      let c: ReturnType<typeof priceChoice>;
      try { c = priceChoice((p as { options?: OptionGroup[] }).options, l.options, p.name); }
      catch (e) { if (e instanceof OptionsError) throw new UnprocessableEntityException({ statusCode: 422, code: 'OPTIONS_INVALID', message: e.message }); throw e; }
      const note = (l.note ?? '').trim().slice(0, 140);
      const k = `${l.productId}|${c.key}|${note}`;
      const cur = qty.get(k);
      qty.set(k, { pid: l.productId, quantity: Math.min(99, (cur?.quantity ?? 0) + l.quantity), note, extra: c.extraCents, options: c.picked.length ? c.picked : undefined });
    }
    await this.run(async (session) => {
      const cur = await this.tabs.findOne({ _id: tab._id, status: 'open' }).session(session);
      if (!cur) throw new ConflictException('Esta conta já foi fechada');
      if (cur.payment?.released) throw new ConflictException('A conta já foi liberada para pagamento. Para pedir mais, chame o garçom.');
      const promos = await this.promotions.activeFor(eid, ids, session);
      const now = new Date();
      const added: TabItem[] = [];
      for (const { pid, quantity, note, extra, options } of qty.values()) {
        const p = byId.get(pid)!;
        const r = await this.products.decreaseQuantity(eid, pid, quantity, session);
        const normal = toCents(onlineEffectivePrice(p));
        const base = { productId: p._id as Types.ObjectId, productName: p.name, productCode: p.code, originalUnitPriceCents: Math.max(toCents(p.price), normal) + extra, stockTracked: r.tracked, note, by, at: now, status: 'new' as const, ...(options ? { options } : {}) };
        const pr = promos.get(pid);
        const promoQty = pr && pr.promoPriceCents < normal ? await this.promotions.consume(pr, quantity, session) : 0;
        if (promoQty > 0) added.push({ ...base, _id: new Types.ObjectId(), unitPriceCents: pr!.promoPriceCents + extra, quantity: promoQty, totalCents: (pr!.promoPriceCents + extra) * promoQty, promotionId: pr!._id as Types.ObjectId });
        if (quantity - promoQty > 0) added.push({ ...base, _id: new Types.ObjectId(), unitPriceCents: normal + extra, quantity: quantity - promoQty, totalCents: (normal + extra) * (quantity - promoQty) });
      }
      const items = [...cur.items, ...added];
      if (items.length > MAX_ITEMS) throw new UnprocessableEntityException('Conta com itens demais. Peça ao garçom para abrir outra.');
      await this.tabs.updateOne({ _id: cur._id }, { $set: { items, ...tabTotals(items, cur.serviceRateBps) } }, { session });
    });
    return (await this.tabs.findById(tab._id))!;
  }

  async customerAdd(slug: string, id: string, t: string, lines: TabLine[]) {
    const tab = await this.byToken(slug, id, t);
    const { store } = await this.stores.publicBySlug(slug, { forOrder: true });
    this.assertTabs(store);
    return this.present(await this.addLines(tab, lines, 'customer'), store, true);
  }

  async staffAdd(eid: string, id: string, lines: TabLine[], who: Who = null) {
    const tab = await this.mine(eid, id);
    await this.addLines(tab, lines, 'staff');
    await this.claim(tab, who);
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  private async claim(tab: TabDocument, who: Who) {
    const c = this.claimSet(tab, who);
    if (c.waiter) await this.tabs.updateOne({ _id: tab._id, 'waiter.id': null }, { $set: c });
  }

  /** Garçom assume a conta (passa a receber os chamados dela). Dono pode tirar o responsável (who = null). */
  async assign(eid: string, id: string, who: Who) {
    const tab = await this.mine(eid, id);
    await this.tabs.updateOne({ _id: tab._id }, { $set: { waiter: who && who.role === 'waiter' ? { id: who.id, name: who.name } : null } });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  /** Itens entregues na mesa (sem ids = todos os pendentes). */
  async serve(eid: string, id: string, itemIds?: string[], who: Who = null) {
    const tab = await this.mine(eid, id);
    await this.claim(tab, who);
    const want = itemIds?.length ? new Set(itemIds) : null;
    const items = tab.items.map((i) => (i.status === 'new' && (!want || want.has(String(i._id))) ? { ...i, status: 'served' as const } : i));
    await this.tabs.updateOne({ _id: tab._id }, { $set: { items } });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  /** Tira um item da conta (devolve estoque e promoção). Se a conta estava liberada, volta a ficar aberta (o valor mudou). */
  async cancelItem(eid: string, id: string, itemId: string, reason = '') {
    const tab = await this.mine(eid, id);
    await this.run(async (session) => {
      const cur = await this.tabs.findOne({ _id: tab._id, status: 'open' }).session(session);
      if (!cur) throw new ConflictException('Esta conta já foi fechada');
      const it = cur.items.find((i) => String(i._id) === itemId);
      if (!it) throw new NotFoundException('Item não encontrado');
      if (it.status === 'cancelled') return;
      if (it.promotionId) await this.promotions.release(it.promotionId, it.quantity, session);
      if (it.stockTracked !== false) await this.products.increaseQuantity(eid, String(it.productId), it.quantity, session);
      const items = cur.items.map((i) => (String(i._id) === itemId ? { ...i, status: 'cancelled' as const, cancelReason: reason.trim().slice(0, 140) } : i));
      await this.tabs.updateOne({ _id: cur._id }, { $set: { items, ...tabTotals(items, cur.serviceRateBps), ...this.unreleaseSet() } }, { session });
    });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  /** Liga/desliga a taxa de serviço desta conta. */
  async setService(eid: string, id: string, on: boolean) {
    const tab = await this.mine(eid, id);
    if (tab.status !== 'open') throw new ConflictException('Esta conta já foi fechada');
    const store = await this.storeOf(tab);
    const rate = on ? store.tables?.serviceRateBps ?? 0 : 0;
    await this.tabs.updateOne({ _id: tab._id, status: 'open' }, { $set: { serviceRateBps: rate, ...tabTotals(tab.items, rate), ...this.unreleaseSet() } });
    return this.present((await this.tabs.findById(tab._id))!, store);
  }

  async move(eid: string, id: string, table: number) {
    const tab = await this.mine(eid, id);
    if (tab.status !== 'open') throw new ConflictException('Esta conta já foi fechada');
    const store = await this.storeOf(tab);
    this.checkTable(store, table);
    await this.tabs.updateOne({ _id: tab._id }, { $set: { table } });
    return this.present((await this.tabs.findById(tab._id))!, store);
  }

  async rename(eid: string, id: string, name: string) {
    const tab = await this.mine(eid, id);
    if (!name.trim()) throw new BadRequestException('Diga um nome para a conta');
    await this.tabs.updateOne({ _id: tab._id }, { $set: { name: name.trim().slice(0, 40) } });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  // ------------------------------------------------------------------ chamados

  async call(slug: string, id: string, t: string, kind: 'waiter' | 'bill', pay?: TabPay, changeForCents?: number) {
    const tab = await this.byToken(slug, id, t);
    if (tab.status !== 'open') throw new ConflictException('Esta conta já foi fechada');
    if (kind === 'bill' && !tab.items.some((i) => i.status !== 'cancelled')) throw new ConflictException('A conta ainda está vazia');
    const call = { kind, at: new Date(), pay: kind === 'bill' ? pay ?? null : null, changeForCents: kind === 'bill' && pay === 'cash' && changeForCents ? changeForCents : null };
    await this.tabs.updateOne({ _id: tab._id, status: 'open' }, { $set: { call } });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab), true);
  }

  async ackCall(eid: string, id: string, who: Who = null) {
    const tab = await this.mine(eid, id);
    await this.tabs.updateOne({ _id: tab._id }, { $set: { call: null, ...this.claimSet(tab, who) } });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  // ------------------------------------------------------------------ pagamento

  private unreleaseSet() {
    return { 'payment.released': false, 'payment.releasedAt': null, 'payment.releasedBy': '', 'payment.amountCents': null, 'payment.checkoutUrl': null, 'payment.preferenceId': null };
  }

  /** Equipe libera o pagamento: o valor fica congelado e a conta não aceita mais itens. */
  async release(eid: string, id: string, actor: string, who: Who = null) {
    const tab = await this.mine(eid, id);
    await this.claim(tab, who);
    if (tab.status !== 'open') throw new ConflictException('Esta conta já foi fechada');
    if (tab.totalCents < 1) throw new ConflictException('A conta está vazia');
    await this.tabs.updateOne({ _id: tab._id, status: 'open' }, {
      $set: { 'payment.released': true, 'payment.releasedAt': new Date(), 'payment.releasedBy': actor, 'payment.amountCents': tab.totalCents, 'payment.checkoutUrl': null, 'payment.preferenceId': null, call: null },
      $inc: { 'payment.attempt': 1 },
    });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  /** Volta a conta para consumo (cliente quer pedir mais antes de pagar). */
  async reopen(eid: string, id: string) {
    const tab = await this.mine(eid, id);
    if (tab.status !== 'open') throw new ConflictException('Esta conta já foi fechada');
    await this.tabs.updateOne({ _id: tab._id, status: 'open' }, { $set: this.unreleaseSet() });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  /** Cliente paga pelo celular (só depois de liberado): Checkout do Mercado Pago na conta do lojista. */
  async pay(slug: string, id: string, t: string) {
    const tab = await this.byToken(slug, id, t);
    if (tab.status !== 'open') throw new ConflictException('Esta conta já foi paga');
    if (!tab.payment?.released || !tab.payment.amountCents) throw new ConflictException('O pagamento ainda não foi liberado. Chame o garçom para fechar a conta.');
    if (tab.payment.checkoutUrl) return { checkoutUrl: tab.payment.checkoutUrl };
    const store = await this.storeOf(tab);
    if (!store.mp?.userId) throw new ConflictException('Esta loja não recebe pelo celular. Pague com o garçom.');
    const oid = String(tab._id);
    const accessToken = await this.stores.mpAccessToken(store._id);
    const live = tab.items.filter((i) => i.status !== 'cancelled');
    const pref = await this.mp.createPreference({
      accessToken, orderId: oid, idem: `tab-${oid}-${tab.payment.attempt}`, statementDescriptor: store.name, maxInstallments: store.theme?.installments ?? 0,
      items: [
        ...live.map((i) => ({ title: i.productName, quantity: i.quantity, unitCents: i.unitPriceCents })),
        ...(tab.serviceCents > 0 ? [{ title: 'Taxa de serviço', quantity: 1, unitCents: tab.serviceCents }] : []),
      ],
      payer: { name: tab.name },
      backUrl: `${storeUrl(this.front, store)}/comanda/${oid}?t=${encodeURIComponent(t)}`,
      notificationUrl: this.api.startsWith('https://') ? `${this.api}/public/tab-webhook/mercadopago?tab=${oid}&s=${sign(SCOPE, oid)}` : undefined,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await this.tabs.updateOne({ _id: tab._id, status: 'open', 'payment.released': true }, { $set: { 'payment.checkoutUrl': pref.initPoint, 'payment.preferenceId': pref.id } });
    return { checkoutUrl: pref.initPoint };
  }

  async webhook(q: Record<string, unknown>, body: Record<string, any>, headers: { signature?: string; requestId?: string }) {
    const id = String(q.tab ?? '');
    if (!/^[a-f0-9]{24}$/i.test(id) || !verifySigned(SCOPE, id, q.s)) throw new UnauthorizedException('Token inválido');
    const topic = String(q.type ?? q.topic ?? body?.type ?? body?.topic ?? '');
    const paymentId = String(q['data.id'] ?? body?.data?.id ?? (topic === 'payment' ? q.id ?? '' : '') ?? '');
    if (topic !== 'payment' || !MP_PAYMENT_ID_RE.test(paymentId)) return { received: true, outcome: 'ignored' };
    if (headers.signature && !this.mp.verifySignature(paymentId, headers.requestId, headers.signature)) throw new UnauthorizedException('Assinatura inválida');
    const tab = await crossTenant(this.tabs, 'webhook: comanda identificada pela URL assinada').findById(id);
    if (!tab) return { received: true, outcome: 'tab_not_found' };
    return { received: true, outcome: await this.syncPayment(tab, paymentId) };
  }

  /** Público para o webhook único de ordens (mp-orders-webhook.service.ts). */
  async syncPayment(tab: TabDocument, paymentId: string): Promise<string> {
    const store = await this.storeOf(tab);
    const pay = await this.mp.payment(paymentId, await this.stores.mpAccessToken(store._id));
    if (pay.externalReference !== String(tab._id)) return 'not_this_tab';
    if (store.mp?.userId && pay.collectorId && pay.collectorId !== store.mp.userId) { this.logger.error(`Pagamento ${paymentId} da conta ${tab._id} caiu em outra conta`); return 'wrong_account'; }
    if (pay.status !== 'approved') return pay.status === 'rejected' || pay.status === 'cancelled' ? 'not_paid' : 'pending';
    if (tab.status !== 'open') {
      if (tab.payment?.paymentId !== pay.id) {
        // Já tinha sido fechada de outro jeito (dinheiro, maquininha): o cliente pagou duas vezes.
        await this.tabs.updateOne({ _id: tab._id }, { $set: { refundNeeded: true } });
        this.logger.warn(`Conta ${tab._id} paga pelo celular depois de fechada: devolver ${pay.amountCents}`);
        return 'paid_twice';
      }
      return 'already_paid';
    }
    const due = tab.payment?.amountCents ?? tab.totalCents;
    if (pay.amountCents < due) { this.logger.error(`Valor divergente na conta ${tab._id}: esperado=${due} pago=${pay.amountCents}`); return 'amount_mismatch'; }
    await this.closePaid(tab, { paymentMethod: 'online', payment: { provider: 'mp_checkout', method: pay.method ?? 'online', amountCents: pay.amountCents, paymentId: pay.id, reference: String(tab._id), paidAt: new Date() } }, 'cliente (celular)');
    return 'applied';
  }

  /** Pago no local, registrado pela equipe (dinheiro, Pix na chave, maquininha avulsa). */
  async settle(eid: string, id: string, dto: { method: PayMethod; cashReceivedCents?: number | null }, actor: string, who: Who = null) {
    const tab = await this.mine(eid, id);
    const r = await this.closePaid(tab, { paymentMethod: dto.method, cashReceivedCents: dto.cashReceivedCents ?? null }, actor, who);
    return { tab: this.present(r.tab, await this.storeOf(tab)), saleId: String(r.sale._id) };
  }

  /** Cobrança da maquininha/Pix do caixa aprovada (PosService): fecha a conta. */
  async settleFromPos(eid: string, id: string, payment: NonNullable<Sale['payment']>, method: 'pix' | 'card', who: Who = null): Promise<SaleDocument> {
    const tab = await this.mine(eid, id);
    return (await this.closePaid(tab, { paymentMethod: method, payment }, who?.name ? `${who.name} (maquininha)` : 'maquininha', who)).sale;
  }

  /** Valor a cobrar no caixa (maquininha ou Pix) para fechar a conta. */
  async amountDue(eid: string, id: string): Promise<number> {
    const tab = await this.mine(eid, id);
    if (tab.status !== 'open') throw new ConflictException('Esta conta já foi fechada');
    if (tab.totalCents < 1) throw new ConflictException('A conta está vazia');
    return tab.totalCents;
  }

  private async closePaid(tab: TabDocument, p: { paymentMethod: PayMethod | 'online'; cashReceivedCents?: number | null; payment?: Sale['payment'] }, actor: string, who: Who = null): Promise<{ tab: TabDocument; sale: SaleDocument }> {
    const store = await this.storeOf(tab);
    const eid = String(tab.enterpriseId);
    const saleId = await this.run(async (session) => {
      const now = new Date();
      const t = await this.tabs.findOneAndUpdate(
        { _id: tab._id, status: 'open' },
        { $set: { status: 'closed', closedAt: now, call: null, 'payment.paidAt': now, 'payment.paidBy': actor, 'payment.method': p.payment?.method ?? p.paymentMethod, 'payment.provider': p.payment?.provider ?? 'manual', 'payment.paymentId': p.payment?.paymentId ?? null } },
        { returnDocument: 'before', session },
      );
      if (!t) {
        const done = await this.tabs.findById(tab._id).session(session);
        if (done?.saleId) return done.saleId;
        throw new ConflictException('Esta conta já foi fechada');
      }
      const live = t.items.filter((i) => i.status !== 'cancelled');
      if (!live.length) throw new ConflictException('A conta está vazia');
      const items: SaleItem[] = live.map((i) => ({ productId: i.productId, productName: i.productName, productCode: i.productCode, unitPriceCents: i.unitPriceCents, originalUnitPriceCents: i.originalUnitPriceCents, stockTracked: i.stockTracked, quantity: i.quantity, totalCents: i.totalCents, ...(i.options?.length ? { options: i.options } : {}), ...(i.note ? { note: i.note } : {}), ...(i.promotionId ? { promotionId: i.promotionId } : {}) }) as SaleItem);
      const { subtotalCents, serviceCents } = tabTotals(t.items, t.serviceRateBps);
      const sale = await this.sales.recordTabSale(eid, {
        tabId: t._id, tab: { table: t.table, number: t.number, name: t.name, label: this.label(store) }, items, subtotalCents, serviceCents,
        paymentMethod: p.paymentMethod, cashReceivedCents: p.cashReceivedCents ?? null, payment: p.payment,
        // Venda no nome de quem recebeu; pelo celular, do garçom da conta.
        staff: who ? { id: who.id, name: who.name } : t.waiter?.id ? { id: t.waiter.id, name: t.waiter.name } : null,
      }, session);
      await this.tabs.updateOne({ _id: t._id }, { $set: { saleId: sale._id, 'payment.amountCents': subtotalCents + serviceCents } }, { session });
      return sale._id;
    });
    const sale = await this.sales.findById(eid, String(saleId));
    return { tab: (await this.tabs.findById(tab._id))!, sale };
  }

  /** Cancela a conta inteira (devolve estoque e promoções). Conta paga não cancela: estorne a venda. */
  async cancel(eid: string, id: string, reason: string) {
    const tab = await this.mine(eid, id);
    await this.run(async (session) => {
      const t = await this.tabs.findOneAndUpdate({ _id: tab._id, status: 'open' }, { $set: { status: 'cancelled', cancelReason: reason.trim().slice(0, 200), closedAt: new Date(), call: null } }, { returnDocument: 'before', session });
      if (!t) throw new ConflictException('Esta conta já foi fechada');
      for (const i of t.items) {
        if (i.status === 'cancelled') continue;
        if (i.promotionId) await this.promotions.release(i.promotionId, i.quantity, session);
        if (i.stockTracked !== false) await this.products.increaseQuantity(eid, String(i.productId), i.quantity, session);
      }
    });
    return this.present((await this.tabs.findById(tab._id))!, await this.storeOf(tab));
  }

  // ------------------------------------------------------------------ painel

  async board(eid: string) {
    const store = await this.stores.getOrCreate(eid);
    const eoid = new Types.ObjectId(eid);
    const [open, recent, waiters] = await Promise.all([
      this.tabs.find({ enterpriseId: eoid, status: 'open' }).sort({ table: 1, createdAt: 1 }).limit(500),
      this.tabs.find({ enterpriseId: eoid, status: { $in: ['closed', 'cancelled'] }, closedAt: { $gte: new Date(Date.now() - RECENT_MS) } }).sort({ closedAt: -1 }).limit(40),
      this.staff.waitersOnDuty(eid),
    ]);
    // Quem recebe os chamados: o garçom da conta; sem ele, o garçom em serviço que cobre a mesa; sem nenhum, todos.
    const route = (x: TabDocument) => x.waiter?.id ? x.waiter : (() => { const w = waiters.find((g) => g.tables.includes(x.table)); return w ? { id: w.id, name: w.name } : null; })();
    const t = store.tables;
    return {
      mode: modeOf(store),
      tables: { enabled: !!t?.enabled, count: t?.count || 10, label: t?.label || 'Mesa', payment: t?.payment ?? 'tab', serviceRateBps: t?.serviceRateBps ?? 0 },
      slug: store.slug, mpConnected: !!store.mp?.userId,
      waiters,
      open: open.map((x) => ({ ...this.present(x, store), assignedTo: route(x) })),
      recent: recent.map((x) => this.present(x, store)),
    };
  }

  // ------------------------------------------------------------------ impressão automática (cozinha)

  /** Itens novos das contas abertas, ainda não impressos, lançados depois de `since` (no máximo 12 h atrás). */
  async printQueue(eid: string, since: Date) {
    const floor = new Date(Math.max(since.getTime(), Date.now() - 12 * 3_600_000));
    const store = await this.stores.getOrCreate(eid);
    const tabs = await this.tabs.find({ enterpriseId: new Types.ObjectId(eid), status: 'open', items: { $elemMatch: { status: 'new', printedAt: { $exists: false }, at: { $gte: floor } } } }).limit(20).lean();
    return {
      items: tabs.map((t) => ({
        id: String(t._id), table: t.table, number: t.number, name: t.name, label: this.label(store),
        items: t.items.filter((i) => i.status === 'new' && !i.printedAt && i.at >= floor)
          .map((i) => ({ id: String(i._id), name: i.productName, quantity: i.quantity, note: i.note ?? '', options: i.options ?? [], by: i.by, at: i.at })),
      })).filter((t) => t.items.length),
    };
  }

  /** Reserva itens para imprimir: devolve só os que este computador conseguiu reservar. */
  async claimPrint(eid: string, id: string, ids: string[]) {
    const claimed: string[] = [];
    for (const iid of ids.slice(0, 50)) {
      if (!Types.ObjectId.isValid(iid)) continue;
      const r = await this.tabs.updateOne(
        { _id: new Types.ObjectId(id), enterpriseId: new Types.ObjectId(eid), items: { $elemMatch: { _id: new Types.ObjectId(iid), printedAt: { $exists: false } } } },
        { $set: { 'items.$.printedAt': new Date() } },
      );
      if (r.modifiedCount) claimed.push(iid);
    }
    return { claimed };
  }

  async summary(eid: string) {
    const eoid = new Types.ObjectId(eid);
    const [open, calls, newItems] = await Promise.all([
      this.tabs.countDocuments({ enterpriseId: eoid, status: 'open' }),
      this.tabs.countDocuments({ enterpriseId: eoid, status: 'open', call: { $ne: null } }),
      this.tabs.countDocuments({ enterpriseId: eoid, status: 'open', 'items.status': 'new' }),
    ]);
    return { open, calls, newItems };
  }

  present(t: TabDocument, store: StoreDocument, isPublic = false) {
    const items = t.items.filter((i) => !isPublic || i.status !== 'cancelled').map((i) => ({
      id: String(i._id), productId: String(i.productId), name: i.productName, code: i.productCode, quantity: i.quantity, unitPriceCents: i.unitPriceCents,
      totalCents: i.totalCents, promo: !!i.promotionId, note: i.note ?? '', options: i.options ?? [], by: i.by, at: i.at, status: i.status, ...(isPublic ? {} : { cancelReason: i.cancelReason ?? '' }),
    }));
    const p = t.payment;
    return {
      id: String(t._id), number: t.number, table: t.table, tableLabel: this.label(store), name: t.name, status: t.status,
      items, subtotalCents: t.subtotalCents, serviceRateBps: t.serviceRateBps, serviceCents: t.serviceCents, totalCents: t.totalCents,
      call: t.call ? { kind: t.call.kind, at: t.call.at, pay: t.call.pay ?? null, changeForCents: t.call.changeForCents ?? null } : null,
      waiter: t.waiter?.id ? { id: t.waiter.id, name: t.waiter.name } : null,
      payment: {
        released: !!p?.released, releasedAt: p?.releasedAt ?? null, amountCents: p?.amountCents ?? null, paidAt: p?.paidAt ?? null, method: p?.method ?? null, provider: p?.provider ?? null,
        online: !!store.mp?.userId, ...(isPublic ? {} : { releasedBy: p?.releasedBy ?? '', paidBy: p?.paidBy ?? '', checkoutPending: !!p?.checkoutUrl }),
      },
      saleId: t.saleId ? String(t.saleId) : null, closedAt: t.closedAt, cancelReason: t.cancelReason || '',
      createdAt: (t as unknown as { createdAt: Date }).createdAt, openedBy: t.openedBy,
      ...(isPublic ? { store: { name: store.name, slug: store.slug, legal: { name: store.legal?.name ?? '', document: store.legal?.document ?? '' } } } : { refundNeeded: !!t.refundNeeded }),
    };
  }
}
