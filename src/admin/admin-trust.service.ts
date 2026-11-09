import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';

import { Store } from '../store/schema/store.schema';
import { Order } from '../store/schema/order.schema';
import { Shopper } from '../shopper/schema/shopper.schema';
import { ShopperService } from '../shopper/shopper.service';
import { EnterpriseSchema } from '../enterprise/schema/enterprise.schema';
import { CustomerSchema } from '../customer/schema/customer.schema';
import { MessagesService } from '../messages/messages.service';
import { AuditLog } from './audit.schema';
import { ProtectionService } from '../store/protection.service';
import { ShopperListQuery, StoreListQuery } from './admin.dto';
import { escapeRegex } from '../common/mongo';
import { formatDoc, onlyDigits, validDoc } from '../common/br-doc';
import { LEGAL_VERSIONS, maskEmail } from '../common/legal-versions';
import { crossTenant } from '../common/security/tenant-guard.plugin';

const DAY = 24 * 3600_000;
const oid = (s: string | Types.ObjectId) => new Types.ObjectId(String(s));
type Actor = { id: string; email: string };
/** Pedidos que viraram venda (pagos em diante, sem cancelados). */
const SOLD = ['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'];
const EMPTY = { $in: ['', null] };
/** Loja sem algum dado obrigatório do vendedor (Decreto 7.962/2013). */
const LEGAL_MISSING = { $or: [{ 'legal.name': EMPTY }, { 'legal.document': EMPTY }, { 'legal.address': EMPTY }, { 'legal.email': EMPTY }] };
const legalOk = (l?: Store['legal'] | null) => !!(l?.name && validDoc(l.document) && l.address && l.email);

/**
 * Controle da plataforma sobre as lojas online e os dados pessoais (LGPD):
 * suspender loja por denúncia, acompanhar aceites e atender pedidos de titulares.
 */
@Injectable()
export class AdminTrustService {
  constructor(
    @InjectModel(Store.name) private readonly stores: Model<Store>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Shopper.name) private readonly shoppers: Model<Shopper>,
    @InjectModel(EnterpriseSchema.name) private readonly enterprises: Model<EnterpriseSchema>,
    @InjectModel(CustomerSchema.name) private readonly customers: Model<CustomerSchema>,
    @InjectModel(AuditLog.name) private readonly audit: Model<AuditLog>,
    private readonly shopperService: ShopperService,
    private readonly messages: MessagesService,
    private readonly protection: ProtectionService,
  ) {
    this.stores = crossTenant(stores, 'admin: só rotas @Roles(admin), enxerga todas as lojas');
    this.orders = crossTenant(orders, 'admin: só rotas @Roles(admin), enxerga todas as lojas');
    this.customers = crossTenant(customers, 'admin: só rotas @Roles(admin), enxerga todas as lojas');
  }

  // ------------------------------------------------------------------ lojas

  async listStores(q: StoreListQuery) {
    const and: QueryFilter<Store>[] = [];
    if (q.search) {
      const s = q.search.slice(0, 80); const rx = new RegExp(escapeRegex(s), 'i'); const digits = onlyDigits(s);
      and.push({ $or: [{ name: rx }, { slug: rx }, { 'legal.name': rx }, ...(digits.length >= 4 ? [{ 'legal.document': new RegExp(digits) }] : [])] });
    }
    if (q.status === 'online') and.push({ enabled: true });
    if (q.status === 'paused') and.push({ enabled: true, ordersPaused: true });
    if (q.status === 'offline') and.push({ enabled: false, 'adminBlock.at': null });
    if (q.status === 'blocked') and.push({ 'adminBlock.at': { $ne: null } });
    if (q.status === 'no_legal') and.push({ enabled: true }, LEGAL_MISSING);
    const filter = and.length ? { $and: and } : {};
    const [rows, total] = await Promise.all([
      this.stores.find(filter).select('-logo -banner -slides -theme').sort({ enabled: -1, updatedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      this.stores.countDocuments(filter),
    ]);
    const eids = rows.map((r) => r.enterpriseId);
    const [ents, stats] = await Promise.all([
      this.enterprises.find({ _id: { $in: eids } }).select('name email status').lean(),
      this.orderStats(eids),
    ]);
    const ent = new Map(ents.map((e) => [String(e._id), e]));
    return { items: rows.map((s) => this.presentStore(s, ent.get(String(s.enterpriseId)), stats.get(String(s.enterpriseId)))), total, page: q.page, limit: q.limit };
  }

  async getStore(id: string) {
    const s = await this.stores.findById(id).select('-logo -banner -slides').lean();
    if (!s) throw new NotFoundException('Loja não encontrada');
    const [e, stats, recent, audit] = await Promise.all([
      this.enterprises.findById(s.enterpriseId).select('name email status').lean(),
      this.orderStats([s.enterpriseId]),
      this.orders.find({ enterpriseId: s.enterpriseId, status: { $ne: 'expired' } }).sort({ createdAt: -1 }).limit(10)
        .select('number status totalCents createdAt customer.name refundNeeded consent').lean(),
      this.audit.find({ targetEnterpriseId: s.enterpriseId, action: /^store\./ }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    return {
      ...this.presentStore(s, e ?? undefined, stats.get(String(s.enterpriseId))),
      policies: s.policies, contacts: s.contacts,
      recentOrders: recent.map((o) => ({ id: String(o._id), number: o.number, status: o.status, totalCents: o.totalCents, createdAt: (o as { createdAt?: Date }).createdAt, customerName: o.customer?.name ?? '', refundNeeded: !!o.refundNeeded, consent: !!o.consent?.acceptedAt })),
      audit: audit.map((a) => ({ id: String(a._id), action: a.action, actorEmail: a.actorEmail, meta: a.meta, createdAt: (a as { createdAt?: Date }).createdAt })),
    };
  }

  async blockStore(actor: Actor, id: string, reason: string, notify = true) {
    const s = await this.stores.findById(id);
    if (!s) throw new NotFoundException('Loja não encontrada');
    if (s.adminBlock?.at) throw new BadRequestException('A loja já está suspensa');
    const wasOnline = s.enabled;
    await this.stores.updateOne({ _id: s._id }, { $set: { enabled: false, adminBlock: { at: new Date(), reason, by: actor.email } } });
    await this.log(actor, 'store.block', s.enterpriseId, { storeId: id, slug: s.slug, reason, wasOnline });
    if (notify) {
      await this.messages.sendTo(actor, [s.enterpriseId], {
        title: 'Sua loja online foi suspensa', level: 'warning',
        body: `A loja "${s.name}" (balcao.app/loja/${s.slug}) foi tirada do ar pela plataforma.\n\nMotivo: ${reason}\n\nAs vendas no balcão continuam normais. Para reativar, fale com o suporte pelo e-mail que aparece nos Termos de Uso.`,
      });
    }
    return this.getStore(id);
  }

  async unblockStore(actor: Actor, id: string, note = '', notify = true) {
    const s = await this.stores.findById(id);
    if (!s) throw new NotFoundException('Loja não encontrada');
    if (!s.adminBlock?.at) throw new BadRequestException('A loja não está suspensa');
    await this.stores.updateOne({ _id: s._id }, { $set: { adminBlock: { at: null, reason: '', by: '' } } });
    await this.log(actor, 'store.unblock', s.enterpriseId, { storeId: id, slug: s.slug, note, previousReason: s.adminBlock.reason });
    if (notify) {
      await this.messages.sendTo(actor, [s.enterpriseId], {
        title: 'Sua loja online foi liberada', level: 'info',
        body: `A suspensão da loja "${s.name}" foi retirada${note ? `: ${note}` : ''}.\n\nPara voltar a vender online, abra Loja online no painel e ligue a loja.`,
      });
    }
    return this.getStore(id);
  }

  // ------------------------------------------------------------------ conformidade (LGPD e documentos)

  async compliance() {
    const d30 = new Date(Date.now() - 30 * DAY);
    const active = { role: 'user' as const, status: 'active' as const };
    const current = { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy };
    const [entTotal, entCurrent, entNever, online, onlineNoLegal, blocked, noLegalRows, shTotal, sh30, shConsent, shCurrent, ord30, ordConsent, req30, recentReq] = await Promise.all([
      this.enterprises.countDocuments(active),
      this.enterprises.countDocuments({ ...active, ...current }),
      this.enterprises.countDocuments({ ...active, termsAcceptedAt: null }),
      this.stores.countDocuments({ enabled: true }),
      this.stores.countDocuments({ enabled: true, ...LEGAL_MISSING }),
      this.stores.countDocuments({ 'adminBlock.at': { $ne: null } }),
      this.stores.find({ enabled: true, ...LEGAL_MISSING }).select('name slug enterpriseId').limit(10).lean(),
      this.shoppers.countDocuments({}),
      this.shoppers.countDocuments({ createdAt: { $gte: d30 } }),
      this.shoppers.countDocuments({ 'consents.acceptedAt': { $ne: null } }),
      this.shoppers.countDocuments({ 'consents.termsVersion': LEGAL_VERSIONS.terms }),
      this.orders.countDocuments({ createdAt: { $gte: d30 }, status: { $ne: 'expired' } }),
      this.orders.countDocuments({ createdAt: { $gte: d30 }, status: { $ne: 'expired' }, 'consent.acceptedAt': { $ne: null } }),
      this.audit.aggregate<{ _id: string; n: number }>([
        { $match: { action: { $in: ['shopper.delete', 'shopper.export'] }, createdAt: { $gte: d30 } } },
        { $group: { _id: { $concat: ['$action', ':', { $ifNull: ['$meta.by', 'admin'] }] }, n: { $sum: 1 } } },
      ]),
      this.audit.find({ action: { $in: ['shopper.delete', 'shopper.export'] } }).sort({ createdAt: -1 }).limit(15).lean(),
    ]);
    const req = (k: string) => req30.find((r) => r._id === k)?.n ?? 0;
    const names = new Map((await this.enterprises.find({ _id: { $in: noLegalRows.map((r) => r.enterpriseId) } }).select('name').lean()).map((e) => [String(e._id), e.name]));
    return {
      versions: LEGAL_VERSIONS,
      merchants: { active: entTotal, current: entCurrent, outdated: entTotal - entCurrent, neverAccepted: entNever },
      stores: { online, blocked, onlineNoLegal, noLegal: noLegalRows.map((s) => ({ id: String(s._id), name: s.name, slug: s.slug, enterpriseName: names.get(String(s.enterpriseId)) ?? '' })) },
      shoppers: { total: shTotal, new30d: sh30, withConsent: shConsent, current: shCurrent },
      orders30d: { total: ord30, withConsent: ordConsent },
      requests30d: { selfDeleted: req('shopper.delete:titular'), adminDeleted: req('shopper.delete:admin'), adminExported: req('shopper.export:admin') },
      recentRequests: recentReq.map((a) => ({ id: String(a._id), action: a.action, by: (a.meta?.by as string) ?? 'admin', actorEmail: a.actorEmail, email: a.meta?.email ?? '', reason: a.meta?.reason ?? '', createdAt: (a as { createdAt?: Date }).createdAt })),
    };
  }

  /** Avisa no painel os lojistas que ainda não aceitaram a versão atual dos documentos. */
  async remindOutdated(actor: Actor) {
    const ids = (await this.enterprises.find({ role: 'user', status: 'active', $or: [{ termsVersion: { $ne: LEGAL_VERSIONS.terms } }, { privacyVersion: { $ne: LEGAL_VERSIONS.privacy } }] }).select('_id').lean()).map((e) => e._id);
    if (!ids.length) throw new BadRequestException('Todos os lojistas ativos já aceitaram a versão atual');
    const r = await this.messages.sendTo(actor, ids, {
      title: 'Atualizamos os Termos de Uso e a Política de Privacidade', level: 'warning',
      body: 'Publicamos novas versões dos Termos de Uso, da Política de Privacidade, de Reembolso e de Cookies. Elas deixam mais claro o papel de cada um nas vendas online e como os dados dos seus clientes são protegidos.\n\nAbra o painel e confirme a leitura no aviso do topo. Para vender online, preencha também os dados do vendedor em Loja online → Vitrine.',
    });
    await this.log(actor, 'compliance.remind', null, { recipients: r.recipients, version: LEGAL_VERSIONS.terms });
    return r;
  }

  // ------------------------------------------------------------------ compradores (titulares)

  async listShoppers(q: ShopperListQuery) {
    const filter: QueryFilter<Shopper> = {};
    if (q.search) { const rx = new RegExp(escapeRegex(q.search.slice(0, 80)), 'i'); filter.$or = [{ name: rx }, { email: rx }]; }
    const [rows, total] = await Promise.all([
      this.shoppers.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      this.shoppers.countDocuments(filter),
    ]);
    const ids = rows.map((r) => r._id);
    const [ord, cust] = await Promise.all([
      this.orders.aggregate<{ _id: Types.ObjectId; n: number; stores: Types.ObjectId[] }>([{ $match: { shopperId: { $in: ids } } }, { $group: { _id: '$shopperId', n: { $sum: 1 }, stores: { $addToSet: '$enterpriseId' } } }]),
      this.customers.aggregate<{ _id: Types.ObjectId; stores: Types.ObjectId[] }>([{ $match: { shopperId: { $in: ids } } }, { $group: { _id: '$shopperId', stores: { $addToSet: '$enterpriseId' } } }]),
    ]);
    const o = new Map(ord.map((r) => [String(r._id), r])); const c = new Map(cust.map((r) => [String(r._id), r]));
    return {
      items: rows.map((s) => {
        const k = String(s._id);
        const stores = new Set([...(o.get(k)?.stores ?? []), ...(c.get(k)?.stores ?? [])].map(String));
        return {
          id: k, name: s.name, email: s.email, phone: s.phone ?? '', createdAt: (s as { createdAt?: Date }).createdAt, lastLoginAt: s.lastLoginAt ?? null,
          emailVerified: !!s.emailVerifiedAt, consent: s.consents ?? null, consentCurrent: s.consents?.termsVersion === LEGAL_VERSIONS.terms,
          orders: o.get(k)?.n ?? 0, stores: stores.size,
        };
      }),
      total, page: q.page, limit: q.limit,
    };
  }

  /** Cópia dos dados do titular, para responder a um pedido recebido fora da conta (e-mail, telefone). */
  async exportShopper(actor: Actor, id: string, reason: string) {
    const s = await this.shoppers.findById(id).lean();
    if (!s) throw new NotFoundException('Comprador não encontrado');
    const [orders, customers] = await Promise.all([
      this.orders.find({ shopperId: s._id }).sort({ createdAt: -1 }).limit(1000).lean(),
      this.customers.find({ shopperId: s._id }).lean(),
    ]);
    const eids = [...new Set([...orders.map((x) => String(x.enterpriseId)), ...customers.map((x) => String(x.enterpriseId))])];
    const [stores, ents] = await Promise.all([
      this.stores.find({ enterpriseId: { $in: eids.map(oid) } }).select('enterpriseId name').lean(),
      this.enterprises.find({ _id: { $in: eids.map(oid) } }).select('name').lean(),
    ]);
    const nameOf = (e: unknown) => stores.find((x) => String(x.enterpriseId) === String(e))?.name || ents.find((x) => String(x._id) === String(e))?.name || '';
    await this.log(actor, 'shopper.export', null, { shopperId: id, email: maskEmail(s.email), reason, by: 'admin' });
    return {
      geradoEm: new Date().toISOString(),
      atendimento: { motivo: reason, porAdmin: actor.email },
      conta: { nome: s.name, email: s.email, telefone: s.phone, documento: s.document, emailConfirmado: !!s.emailVerifiedAt, criadaEm: (s as { createdAt?: Date }).createdAt ?? null, aceites: s.consents ?? null },
      enderecos: s.addresses ?? [],
      lojas: customers.map((c) => ({ loja: nameOf(c.enterpriseId), nomeNoCadastro: c.name, telefone: (c as { numberWithPrefix?: string }).numberWithPrefix ?? '', endereco: (c as { address?: string }).address ?? '', saldoDevedorCentavos: (c as { debitCents?: number }).debitCents ?? 0 })),
      pedidos: orders.map((x) => ({
        loja: nameOf(x.enterpriseId), numero: x.number, data: (x as { createdAt?: Date }).createdAt, status: x.status, totalCentavos: x.totalCents,
        itens: (x.items ?? []).map((i) => ({ produto: (i as { productName?: string }).productName, quantidade: i.quantity, totalCentavos: (i as { totalCents?: number }).totalCents })),
        entrega: x.shipping?.name, endereco: x.address, contato: x.customer,
      })),
    };
  }

  async deleteShopper(actor: Actor, id: string, reason: string) {
    const s = await this.shoppers.findById(id).select('email').lean();
    if (!s) throw new NotFoundException('Comprador não encontrado');
    await this.shopperService.erase(s._id);
    await this.log(actor, 'shopper.delete', null, { shopperId: id, email: maskEmail(s.email), reason, by: 'admin' });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ reclamações (Compra protegida)

  listDisputes(q: { status?: 'open' | 'escalated' | 'resolved'; page: number; limit: number }) { return this.protection.listDisputes(q); }

  async resolveDispute(actor: Actor, orderId: string, decision: 'refund' | 'seller', note: string) {
    const r = await this.protection.resolve(orderId, decision, actor.email, note);
    const o = await this.orders.findById(orderId).select('enterpriseId').lean();
    await this.log(actor, 'dispute.resolve', o?.enterpriseId ?? null, { orderId, number: r.number, decision, note });
    return r;
  }

  // ------------------------------------------------------------------ resumos usados por outras telas

  /** Números das lojas para o painel geral. */
  async storeSummary() {
    const d30 = new Date(Date.now() - 30 * DAY);
    const [online, blocked, noLegal, total, sold] = await Promise.all([
      this.stores.countDocuments({ enabled: true }),
      this.stores.countDocuments({ 'adminBlock.at': { $ne: null } }),
      this.stores.countDocuments({ enabled: true, ...LEGAL_MISSING }),
      this.stores.countDocuments({}),
      this.orders.aggregate<{ n: number; cents: number; fee: number }>([{ $match: { status: { $in: SOLD }, createdAt: { $gte: d30 } } }, { $group: { _id: null, n: { $sum: 1 }, cents: { $sum: '$totalCents' }, fee: { $sum: '$feeCents' } } }]),
    ]);
    return { total, online, blocked, onlineNoLegal: noLegal, orders30d: { count: sold[0]?.n ?? 0, totalCents: sold[0]?.cents ?? 0, feeCents: sold[0]?.fee ?? 0 } };
  }

  /** Loja e aceites de uma empresa, para a ficha da empresa no admin. */
  async enterpriseTrust(e: { _id: unknown; termsVersion?: string | null; privacyVersion?: string | null; termsAcceptedAt?: Date | null }) {
    const s = await this.stores.findOne({ enterpriseId: oid(String(e._id)) }).select('name slug enabled ordersPaused legal adminBlock').lean<Store & { _id: Types.ObjectId }>();
    return {
      store: s ? { id: String(s._id), name: s.name, slug: s.slug, enabled: s.enabled, ordersPaused: s.ordersPaused, legalOk: legalOk(s.legal), blocked: s.adminBlock?.at ? { at: s.adminBlock.at, reason: s.adminBlock.reason, by: s.adminBlock.by } : null } : null,
      consent: {
        termsVersion: e.termsVersion ?? null, privacyVersion: e.privacyVersion ?? null, acceptedAt: e.termsAcceptedAt ?? null,
        current: e.termsVersion === LEGAL_VERSIONS.terms && e.privacyVersion === LEGAL_VERSIONS.privacy,
      },
    };
  }

  // ------------------------------------------------------------------ apoio

  private async orderStats(eids: Types.ObjectId[]) {
    const d30 = new Date(Date.now() - 30 * DAY);
    const rows = await this.orders.aggregate<{ _id: Types.ObjectId; n: number; cents: number; last: Date | null; refunds: number }>([
      { $match: { enterpriseId: { $in: eids }, status: { $ne: 'expired' } } },
      { $group: {
        _id: '$enterpriseId',
        n: { $sum: { $cond: [{ $and: [{ $in: ['$status', SOLD] }, { $gte: ['$createdAt', d30] }] }, 1, 0] } },
        cents: { $sum: { $cond: [{ $and: [{ $in: ['$status', SOLD] }, { $gte: ['$createdAt', d30] }] }, '$totalCents', 0] } },
        last: { $max: '$createdAt' },
        refunds: { $sum: { $cond: ['$refundNeeded', 1, 0] } },
      } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r]));
  }

  private presentStore(s: Store & { _id: unknown; createdAt?: Date; updatedAt?: Date }, e?: { name?: string; email?: string; status?: string }, st?: { n: number; cents: number; last: Date | null; refunds: number }) {
    const l = s.legal ?? { name: '', document: '', address: '', email: '', phone: '' };
    return {
      id: String(s._id), enterpriseId: String(s.enterpriseId), enterpriseName: e?.name ?? '—', enterpriseEmail: e?.email ?? '', enterpriseStatus: e?.status ?? 'active',
      slug: s.slug, name: s.name, segment: s.segment, city: s.city, state: s.state,
      enabled: !!s.enabled, ordersPaused: !!s.ordersPaused, listed: s.listed !== false, mpConnected: !!s.mp?.userId,
      legal: { name: l.name ?? '', document: l.document ? formatDoc(l.document) : '', address: l.address ?? '', email: l.email ?? '', phone: l.phone ?? '' },
      legalOk: legalOk(l),
      blocked: s.adminBlock?.at ? { at: s.adminBlock.at, reason: s.adminBlock.reason, by: s.adminBlock.by } : null,
      orders30d: { count: st?.n ?? 0, totalCents: st?.cents ?? 0 }, lastOrderAt: st?.last ?? null, refundsPending: st?.refunds ?? 0,
      createdAt: s.createdAt ?? null,
    };
  }

  private async log(actor: Actor, action: string, target: Types.ObjectId | string | null, meta: Record<string, unknown>) {
    await this.audit.create({ actorId: oid(actor.id), actorEmail: actor.email, action, targetEnterpriseId: target ? oid(target) : null, meta });
  }
}
