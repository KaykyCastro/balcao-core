import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';

import { EnterpriseSchema } from '../enterprise/schema/enterprise.schema';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { Sale } from '../sale/schema/sale.schema';
import { ProductSchema } from '../products/schema/product.schema';
import { CustomerSchema } from '../customer/schema/customer.schema';
import { FeeEntry } from '../billing/schema/fee-entry.schema';
import { Invoice } from '../billing/schema/invoice.schema';
import { BillingService } from '../billing/billing.service';
import { MessagesService } from '../messages/messages.service';
import { SettingsService } from '../settings/settings.service';
import { SendMessageDto, SentQuery } from '../messages/messages.dto';
import { TRIAL_DAYS } from '../billing/billing.constants';
import { feeWaived, inTrial, trialDaysLeft, trialEnd } from '../billing/billing.rules';
import { AuditLog } from './audit.schema';
import { AuditQuery, EnterpriseListQuery, InvoiceListQuery, UpdateEnterpriseDto, UpdateSettingsDto } from './admin.dto';
import { escapeRegex } from '../common/mongo';
import { BILLING_TZ, periodOf } from '../common/period';

const DAY = 24 * 3600_000;
const oid = (s: string) => new Types.ObjectId(s);
type Actor = { id: string; email: string };

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(EnterpriseSchema.name) private readonly enterprises: Model<EnterpriseSchema>,
    @InjectModel(Sale.name) private readonly sales: Model<Sale>,
    @InjectModel(ProductSchema.name) private readonly products: Model<ProductSchema>,
    @InjectModel(CustomerSchema.name) private readonly customers: Model<CustomerSchema>,
    @InjectModel(FeeEntry.name) private readonly fees: Model<FeeEntry>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(AuditLog.name) private readonly audit: Model<AuditLog>,
    private readonly enterpriseService: EnterpriseService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
    private readonly messages: MessagesService,
  ) {}

  // ------------------------------------------------------------------ métricas

  async metrics() {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * DAY);
    const d365 = new Date(now.getTime() - 365 * DAY);
    const tenants = { role: 'user' as const };
    const trialExpr = { $gt: [{ $ifNull: ['$trialEndsAt', { $add: ['$createdAt', TRIAL_DAYS * DAY] }] }, now] };
    const completed = { status: 'completed' as const };
    const sum = { $sum: 1 };

    const [total, suspended, blocked, trial, new30, signupsByMonth, salesAgg, salesDaily, feeByMonth, unbilled, invAgg, paidMonth, topRaw] = await Promise.all([
      this.enterprises.countDocuments(tenants),
      this.enterprises.countDocuments({ ...tenants, status: 'suspended' }),
      this.enterprises.countDocuments({ ...tenants, 'billing.status': 'blocked' }),
      this.enterprises.countDocuments({ ...tenants, $expr: trialExpr }),
      this.enterprises.countDocuments({ ...tenants, createdAt: { $gte: d30 } }),
      this.enterprises.aggregate<{ _id: string; count: number }>([
        { $match: { ...tenants, createdAt: { $gte: d365 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: BILLING_TZ } }, count: sum } },
        { $sort: { _id: 1 } },
      ]),
      this.sales.aggregate<{ _id: string; count: number; totalCents: number }>([
        { $match: { ...completed, createdAt: { $gte: d30 } } },
        { $group: { _id: 'last30', count: sum, totalCents: { $sum: '$totalCents' } } },
      ]),
      this.sales.aggregate<{ _id: string; count: number; totalCents: number }>([
        { $match: { ...completed, createdAt: { $gte: d30 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BILLING_TZ } }, count: sum, totalCents: { $sum: '$totalCents' } } },
        { $sort: { _id: 1 } },
      ]),
      this.fees.aggregate<{ _id: string; feeCents: number; baseCents: number }>([
        { $match: { reversedAt: null } },
        { $group: { _id: '$period', feeCents: { $sum: '$feeCents' }, baseCents: { $sum: '$baseCents' } } },
        { $sort: { _id: -1 } }, { $limit: 12 }, { $sort: { _id: 1 } },
      ]),
      this.fees.aggregate<{ sum: number }>([{ $match: { reversedAt: null, invoiceId: null, collected: { $ne: true } } }, { $group: { _id: null, sum: { $sum: '$feeCents' } } }]),
      this.invoices.aggregate<{ _id: string; count: number; cents: number }>([
        { $group: { _id: { s: '$status', o: { $and: [{ $eq: ['$status', 'pending'] }, { $lte: ['$dueDate', now] }] } }, count: sum, cents: { $sum: '$amountCents' } } },
      ]),
      this.invoices.aggregate<{ cents: number; count: number }>([
        { $match: { status: 'paid', paidAt: { $gte: new Date(`${periodOf(now)}-01T03:00:00Z`) } } },
        { $group: { _id: null, cents: { $sum: '$amountCents' }, count: sum } },
      ]),
      this.sales.aggregate<{ _id: Types.ObjectId; count: number; totalCents: number }>([
        { $match: { ...completed, createdAt: { $gte: d30 } } },
        { $group: { _id: '$enterpriseId', count: sum, totalCents: { $sum: '$totalCents' } } },
        { $sort: { totalCents: -1 } }, { $limit: 10 },
      ]),
    ]);

    const names = new Map((await this.enterprises.find({ _id: { $in: topRaw.map((t) => t._id) } }).select('name email')).map((e) => [String(e._id), e]));
    const inv = (status: string, overdue?: boolean) => {
      const rows = (invAgg as unknown as { _id: { s: string; o: boolean }; count: number; cents: number }[]).filter((r) => r._id.s === status && (overdue === undefined || r._id.o === overdue));
      return { count: rows.reduce((n, r) => n + r.count, 0), cents: rows.reduce((n, r) => n + r.cents, 0) };
    };
    const s30 = salesAgg[0];
    return {
      enterprises: { total, active: total - suspended, trial, blocked, suspended, new30d: new30, signupsByMonth: signupsByMonth.map((r) => ({ month: r._id, count: r.count })) },
      sales30d: { count: s30?.count ?? 0, totalCents: s30?.totalCents ?? 0, daily: salesDaily.map((r) => ({ date: r._id, count: r.count, totalCents: r.totalCents })) },
      revenue: {
        unbilledFeeCents: unbilled[0]?.sum ?? 0,
        pending: inv('pending', false), overdue: inv('pending', true), paidAllTime: inv('paid'),
        paidThisMonth: { count: paidMonth[0]?.count ?? 0, cents: paidMonth[0]?.cents ?? 0 },
        feeByMonth: feeByMonth.map((r) => ({ month: r._id, feeCents: r.feeCents, volumeCents: r.baseCents })),
      },
      topEnterprises30d: topRaw.map((t) => ({ id: String(t._id), name: names.get(String(t._id))?.name ?? '—', email: names.get(String(t._id))?.email ?? '', count: t.count, totalCents: t.totalCents })),
    };
  }

  // ------------------------------------------------------------------ empresas

  async listEnterprises(q: EnterpriseListQuery) {
    const now = new Date();
    const filter: QueryFilter<EnterpriseSchema> = { role: 'user' };
    if (q.search) { const rx = new RegExp(escapeRegex(q.search.slice(0, 80)), 'i'); filter.$or = [{ name: rx }, { email: rx }, { cnpj: rx }]; }
    if (q.status === 'suspended') filter.status = 'suspended';
    if (q.status === 'blocked') filter['billing.status'] = 'blocked';
    if (q.status === 'active') { filter.status = 'active'; filter['billing.status'] = { $ne: 'blocked' }; }
    if (q.status === 'trial') filter.$expr = { $gt: [{ $ifNull: ['$trialEndsAt', { $add: ['$createdAt', TRIAL_DAYS * DAY] }] }, now] };

    const [items, total] = await Promise.all([
      this.enterprises.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.enterprises.countDocuments(filter),
    ]);
    const ids = items.map((e) => e._id);
    const stats = await this.sales.aggregate<{ _id: Types.ObjectId; count: number; totalCents: number }>([
      { $match: { enterpriseId: { $in: ids }, status: 'completed', createdAt: { $gte: new Date(now.getTime() - 30 * DAY) } } },
      { $group: { _id: '$enterpriseId', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
    ]);
    const byId = new Map(stats.map((s) => [String(s._id), s]));
    return { items: items.map((e) => this.presentEnterprise(e, byId.get(String(e._id)))), total, page: q.page, limit: q.limit };
  }

  async getEnterprise(id: string) {
    const e = await this.enterprises.findById(id);
    if (!e) throw new NotFoundException('Empresa não encontrada');
    const [products, customers, salesAll, sales30, invoices, audit] = await Promise.all([
      this.products.countDocuments({ enterpriseId: id }),
      this.customers.countDocuments({ enterpriseId: id }),
      this.sales.aggregate<{ count: number; totalCents: number }>([{ $match: { enterpriseId: oid(id), status: 'completed' } }, { $group: { _id: null, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } }]),
      this.sales.aggregate<{ count: number; totalCents: number }>([{ $match: { enterpriseId: oid(id), status: 'completed', createdAt: { $gte: new Date(Date.now() - 30 * DAY) } } }, { $group: { _id: null, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } }]),
      this.invoices.find({ enterpriseId: id }).sort({ createdAt: -1 }).limit(24),
      this.audit.find({ targetEnterpriseId: id }).sort({ createdAt: -1 }).limit(20),
    ]);
    return {
      ...this.presentEnterprise(e, sales30[0]),
      usage: { products, customers, salesAllTime: salesAll[0] ?? { count: 0, totalCents: 0 } },
      invoices: invoices.map((i) => this.billing.present(i)),
      audit: audit.map((a) => this.presentAudit(a)),
    };
  }

  async updateEnterprise(actor: Actor, id: string, dto: UpdateEnterpriseDto) {
    const target = await this.enterprises.findById(id);
    if (!target) throw new NotFoundException('Empresa não encontrada');
    if (target.role === 'admin') throw new ForbiddenException('Contas de administrador não são alteradas por aqui');
    const trialOps = [dto.extendTrialDays, dto.removeTrialDays, dto.endTrial ? true : undefined].filter((v) => v !== undefined).length;
    if (trialOps > 1) throw new BadRequestException('Escolha só uma ação sobre o teste grátis por vez');
    if (dto.suspended === undefined && dto.feeExempt === undefined && !trialOps && dto.feeCapCents === undefined) throw new BadRequestException('Nada para alterar');

    const patch: Parameters<EnterpriseService['adminPatch']>[1] = {};
    if (dto.suspended !== undefined) { patch.suspended = dto.suspended; patch.suspendedReason = dto.reason; }
    if (dto.feeExempt !== undefined) patch.feeExempt = dto.feeExempt;
    const now = Date.now();
    if (dto.extendTrialDays) {
      const base = Math.max(trialEnd(target).getTime(), now);
      patch.trialEndsAt = new Date(base + dto.extendTrialDays * DAY);
    }
    if (dto.removeTrialDays) patch.trialEndsAt = new Date(Math.max(now, trialEnd(target).getTime() - dto.removeTrialDays * DAY));
    if (dto.endTrial) patch.trialEndsAt = new Date(now);
    if (dto.feeCapCents !== undefined) patch.feeCapCents = dto.feeCapCents;
    const updated = await this.enterpriseService.adminPatch(id, patch);
    await this.log(actor, 'enterprise.update', id, { ...dto });
    return this.presentEnterprise(updated);
  }

  /** Libera uma conta bloqueada por fatura: dá mais prazo às faturas vencidas e reavalia o bloqueio. */
  async unblock(actor: Actor, id: string, extendDays = 7) {
    const overdue = await this.invoices.find({ enterpriseId: id, status: 'pending', dueDate: { $lte: new Date() } });
    for (const inv of overdue) await this.billing.adminExtendInvoice(String(inv._id), extendDays, 'Prazo estendido pelo admin ao desbloquear');
    await this.billing.refreshBlockStatus(id);
    await this.log(actor, 'enterprise.unblock', id, { extendDays, invoices: overdue.length });
    return this.presentEnterprise(await this.enterpriseService.findEnterpriseById(id));
  }

  // ------------------------------------------------------------------ faturas

  async listInvoices(q: InvoiceListQuery) {
    const filter: QueryFilter<Invoice> = {};
    if (q.status) filter.status = q.status;
    if (q.enterpriseId) filter.enterpriseId = q.enterpriseId as never;
    if (q.overdue) { filter.status = 'pending'; filter.dueDate = { $lte: new Date() }; }
    const [rows, total] = await Promise.all([
      this.invoices.find(filter).sort({ dueDate: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.invoices.countDocuments(filter),
    ]);
    const names = new Map((await this.enterprises.find({ _id: { $in: rows.map((r) => r.enterpriseId) } }).select('name email')).map((e) => [String(e._id), e]));
    return {
      items: rows.map((i) => ({ ...this.billing.present(i), enterpriseName: names.get(String(i.enterpriseId))?.name ?? '—', enterpriseEmail: names.get(String(i.enterpriseId))?.email ?? '' })),
      total, page: q.page, limit: q.limit,
    };
  }

  async markInvoicePaid(actor: Actor, id: string, note?: string) {
    const inv = await this.billing.adminMarkPaid(id, note);
    await this.log(actor, 'invoice.mark_paid', String(inv.enterpriseId), { invoiceId: id, amountCents: inv.amountCents, note });
    return this.billing.present(inv);
  }
  async cancelInvoice(actor: Actor, id: string, note?: string) {
    const inv = await this.billing.adminCancelInvoice(id, note);
    await this.log(actor, 'invoice.cancel', String(inv.enterpriseId), { invoiceId: id, amountCents: inv.amountCents, note });
    return this.billing.present(inv);
  }
  async extendInvoice(actor: Actor, id: string, days: number, note?: string) {
    const inv = await this.billing.adminExtendInvoice(id, days, note);
    await this.log(actor, 'invoice.extend', String(inv.enterpriseId), { invoiceId: id, days, note });
    return this.billing.present(inv);
  }
  async runClose(actor: Actor) {
    await this.billing.runDailyClose();
    await this.log(actor, 'billing.run_close', null, {});
    return { ok: true };
  }

  // ------------------------------------------------------------------ configurações da plataforma

  getSettings() { return this.settings.policy(); }

  async updateSettings(actor: Actor, dto: UpdateSettingsDto) {
    if (dto.capCents === undefined && dto.trialDays === undefined && dto.onlineRateBps === undefined && dto.directoryRateBps === undefined) throw new BadRequestException('Nada para alterar');
    const before = await this.settings.policy();
    const after = await this.settings.update({ capCents: dto.capCents, trialDays: dto.trialDays, onlineRateBps: dto.onlineRateBps, directoryRateBps: dto.directoryRateBps }, actor.email);
    await this.log(actor, 'settings.update', null, { before, after });
    return after;
  }

  // ------------------------------------------------------------------ mensagens

  async sendMessage(actor: Actor, dto: SendMessageDto) {
    const r = await this.messages.send(actor, dto);
    await this.log(actor, 'message.send', dto.enterpriseId ?? null, { broadcastId: r.broadcastId, recipients: r.recipients, title: dto.title });
    return r;
  }
  listMessages(q: SentQuery) { return this.messages.sent(q); }
  async recallMessage(actor: Actor, id: string) {
    const r = await this.messages.recall(id);
    await this.log(actor, 'message.recall', null, { broadcastId: id, removed: r.removed });
    return r;
  }

  // ------------------------------------------------------------------ auditoria

  async listAudit(q: AuditQuery) {
    const filter: QueryFilter<AuditLog> = q.enterpriseId ? { targetEnterpriseId: q.enterpriseId as never } : {};
    const [rows, total] = await Promise.all([
      this.audit.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.audit.countDocuments(filter),
    ]);
    return { items: rows.map((a) => this.presentAudit(a)), total, page: q.page, limit: q.limit };
  }

  private async log(actor: Actor, action: string, target: string | null, meta: Record<string, unknown>) {
    await this.audit.create({ actorId: oid(actor.id), actorEmail: actor.email, action, targetEnterpriseId: target ? oid(target) : null, meta });
  }
  private presentAudit(a: AuditLog & { _id: unknown; createdAt?: Date }) {
    return { id: String(a._id), action: a.action, actorEmail: a.actorEmail, targetEnterpriseId: a.targetEnterpriseId ? String(a.targetEnterpriseId) : null, meta: a.meta, createdAt: a.createdAt };
  }

  private presentEnterprise(e: ReturnType<Model<EnterpriseSchema>['hydrate']>, sales30?: { count: number; totalCents: number }) {
    const t = e as unknown as { createdAt: Date; trialEndsAt?: Date | null };
    return {
      id: String(e._id), name: e.name, email: e.email, cnpj: e.cnpj ?? '', createdAt: t.createdAt, lastLoginAt: e.lastLoginAt ?? null,
      status: e.status, suspendedReason: e.suspendedReason ?? null, suspendedAt: e.suspendedAt ?? null,
      billingStatus: e.billing?.status ?? 'active', debtCents: e.debtCents ?? 0, feeExempt: !!e.feeExempt, feeCapCents: e.feeCapCents ?? null,
      /** Por que não paga taxa agora ('admin' | 'exempt' | 'trial'), ou null = está pagando. */
      feeWaivedReason: feeWaived({ ...t, role: e.role, feeExempt: e.feeExempt }),
      trial: { active: inTrial(t), endsAt: trialEnd(t), daysLeft: trialDaysLeft(t) },
      sales30d: { count: sales30?.count ?? 0, totalCents: sales30?.totalCents ?? 0 },
    };
  }
}
