import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { isDuplicateKeyError } from '../common/mongo';
import { Coupon } from './schema/coupon.schema';
import { Order } from './schema/order.schema';
import { StoreCredit } from './schema/store-credit.schema';
import { Store } from './schema/store.schema';
import { allocateCredit, couponDiscountCents, couponLabel, couponProblem, normalizeCode, type CouponLike } from './rewards.rules';
import { crossTenant } from '../common/security/tenant-guard.plugin';

export interface CouponInput {
  code: string; title?: string; kind: 'percent' | 'amount'; percent?: number | null; amountCents?: number | null; minOrderCents?: number;
  maxDiscountCents?: number | null; startsAt?: Date | null; endsAt?: Date | null; maxUses?: number | null; onePerCustomer?: boolean; public?: boolean; active?: boolean;
}
type CouponDoc = Coupon & { _id: Types.ObjectId; createdAt?: Date };
const oid = (x: string | Types.ObjectId) => (typeof x === 'string' ? new Types.ObjectId(x) : x);
const LIVE_ORDER = { $nin: ['expired', 'cancelled'] as ('expired' | 'cancelled')[] };

/**
 * Cupons e cashback da loja online. Tudo que mexe em dinheiro roda dentro da transação do pedido
 * (session): reservar o cupom, usar o crédito, ganhar cashback e devolver quando o pedido não vinga.
 */
@Injectable()
export class RewardsService {
  constructor(
    @InjectModel(Coupon.name) private readonly coupons: Model<Coupon>,
    @InjectModel(StoreCredit.name) private readonly credits: Model<StoreCredit>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Store.name) private readonly stores: Model<Store>,
  ) {}

  // ------------------------------------------------------------------ lojista

  private presentCoupon(c: CouponDoc) {
    const now = new Date();
    const live = !couponProblem(c, Number.MAX_SAFE_INTEGER, now);
    return {
      id: String(c._id), code: c.code, title: c.title, kind: c.kind, percent: c.percent, amountCents: c.amountCents, label: couponLabel(c),
      minOrderCents: c.minOrderCents, maxDiscountCents: c.maxDiscountCents, startsAt: c.startsAt, endsAt: c.endsAt, maxUses: c.maxUses, used: c.used,
      remaining: c.maxUses != null ? Math.max(0, c.maxUses - c.used) : null, onePerCustomer: c.onePerCustomer, public: c.public, active: c.active, live,
    };
  }

  private validateInput(d: Partial<CouponInput>) {
    if (d.kind === 'percent' && !(d.percent && d.percent >= 1 && d.percent <= 90)) throw new UnprocessableEntityException('Desconto em % precisa ser de 1 a 90');
    if (d.kind === 'amount' && !(d.amountCents && d.amountCents >= 100)) throw new UnprocessableEntityException('Desconto em reais precisa ser de pelo menos R$ 1,00');
    if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) throw new UnprocessableEntityException('O fim precisa ser depois do início');
  }

  async listCoupons(eid: string) {
    const rows = (await this.coupons.find({ enterpriseId: oid(eid) }).sort({ createdAt: -1 }).limit(200).lean()) as CouponDoc[];
    return rows.map((c) => this.presentCoupon(c));
  }

  async createCoupon(eid: string, d: CouponInput) {
    const code = normalizeCode(d.code);
    this.validateInput(d);
    try {
      const c = await this.coupons.create({ ...d, code, enterpriseId: oid(eid), percent: d.kind === 'percent' ? d.percent : null, amountCents: d.kind === 'amount' ? d.amountCents : null, maxDiscountCents: d.kind === 'percent' ? d.maxDiscountCents ?? null : null, used: 0 });
      return this.presentCoupon(c.toObject() as CouponDoc);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe um cupom com esse código');
      throw e;
    }
  }

  async updateCoupon(eid: string, id: string, d: Partial<CouponInput>) {
    const cur = await this.coupons.findOne({ _id: id, enterpriseId: oid(eid) }).lean();
    if (!cur) throw new NotFoundException('Cupom não encontrado');
    const next = { ...cur, ...d } as CouponInput;
    this.validateInput(next);
    const set: Record<string, unknown> = { ...d };
    if (d.code !== undefined) set.code = normalizeCode(d.code);
    if (next.kind === 'percent') { set.amountCents = null; } else { set.percent = null; set.maxDiscountCents = null; }
    try {
      const c = await this.coupons.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
      return this.presentCoupon(c as CouponDoc);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe um cupom com esse código');
      throw e;
    }
  }

  async deleteCoupon(eid: string, id: string) {
    // Cupom já usado em pedido fica guardado (desativado) para o histórico; nunca usado, apaga.
    const c = await this.coupons.findOne({ _id: id, enterpriseId: oid(eid) });
    if (!c) throw new NotFoundException('Cupom não encontrado');
    if (c.used > 0 || (await this.orders.exists({ 'discount.couponId': c._id }))) { c.active = false; await c.save(); return { deleted: false, deactivated: true }; }
    await c.deleteOne();
    return { deleted: true, deactivated: false };
  }

  // ------------------------------------------------------------------ vitrine

  /** Cupons públicos que estão valendo agora (de uma loja, ou de várias para o marketplace). */
  async publicCoupons(enterpriseIds: string[], limit = 30) {
    const now = new Date();
    const rows = (await this.coupons.find({
      enterpriseId: { $in: enterpriseIds.map(oid) }, public: true, active: true,
      $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }],
    }).sort({ endsAt: 1, createdAt: -1 }).limit(limit * 2).lean()) as CouponDoc[];
    // Os que acabam antes primeiro (sem data de fim por último); depois os com menos usos restantes.
    const end = (c: CouponDoc) => (c.endsAt ? new Date(c.endsAt).getTime() : Number.MAX_SAFE_INTEGER);
    rows.sort((a, b) => end(a) - end(b) || (a.maxUses != null ? a.maxUses - a.used : 1e9) - (b.maxUses != null ? b.maxUses - b.used : 1e9));
    return rows.filter((c) => c.maxUses == null || c.used < c.maxUses).slice(0, limit).map((c) => ({
      code: c.code, title: c.title, label: couponLabel(c), kind: c.kind, percent: c.percent, amountCents: c.amountCents, minOrderCents: c.minOrderCents,
      maxDiscountCents: c.maxDiscountCents, endsAt: c.endsAt, remaining: c.maxUses != null ? c.maxUses - c.used : null, enterpriseId: String(c.enterpriseId),
    }));
  }

  /** Confere um cupom para um subtotal (prévia no checkout). */
  async check(eid: string, code: string, subtotalCents: number, email?: string) {
    const c = await this.findUsable(eid, code, subtotalCents, email);
    return { code: c.code, label: couponLabel(c), discountCents: couponDiscountCents(c, subtotalCents) };
  }

  private async findUsable(eid: string, code: string, subtotalCents: number, email?: string, session?: ClientSession) {
    const c = (await this.coupons.findOne({ enterpriseId: oid(eid), code: normalizeCode(code) }).session(session ?? null).lean()) as CouponDoc | null;
    if (!c) throw new UnprocessableEntityException({ statusCode: 422, code: 'COUPON_INVALID', message: 'Cupom não encontrado nesta loja' });
    const usedByMe = c.onePerCustomer && email ? await this.orders.countDocuments({ enterpriseId: oid(eid), 'discount.couponId': c._id, 'customer.email': email.trim().toLowerCase(), status: LIVE_ORDER }).session(session ?? null) : 0;
    const problem = couponProblem(c as CouponLike, subtotalCents, new Date(), usedByMe, c.onePerCustomer);
    if (problem) throw new UnprocessableEntityException({ statusCode: 422, code: 'COUPON_INVALID', message: problem });
    return c;
  }

  // ------------------------------------------------------------------ dentro do pedido

  /** Reserva o cupom para o pedido (soma um uso só se ainda houver). Devolve o desconto. */
  async consumeCoupon(eid: string, code: string, subtotalCents: number, email: string, session: ClientSession) {
    const c = await this.findUsable(eid, code, subtotalCents, email, session);
    const r = await this.coupons.updateOne(
      { _id: c._id, ...(c.maxUses != null ? { used: { $lt: c.maxUses } } : {}) },
      { $inc: { used: 1 } }, { session },
    );
    if (!r.modifiedCount) throw new UnprocessableEntityException({ statusCode: 422, code: 'COUPON_INVALID', message: 'Este cupom acabou de ser todo usado' });
    return { couponId: c._id, code: c.code, discountCents: couponDiscountCents(c, subtotalCents) };
  }

  async releaseCoupon(couponId: Types.ObjectId | null | undefined, session: ClientSession) {
    if (couponId) await this.coupons.updateOne({ _id: couponId, used: { $gt: 0 } }, { $inc: { used: -1 } }, { session });
  }

  /** Configuração de cashback da loja (desligado = null). */
  async cashbackOf(eid: string, session?: ClientSession) {
    const s = await this.stores.findOne({ enterpriseId: oid(eid) }).select('cashback').session(session ?? null).lean();
    const cb = (s as { cashback?: { enabled?: boolean; rateBps?: number; expiresDays?: number } } | null)?.cashback;
    return cb?.enabled && cb.rateBps ? { rateBps: cb.rateBps, expiresDays: cb.expiresDays || 90 } : null;
  }

  /** Saldo de crédito do comprador nesta loja (só o que está valendo). */
  async balance(shopperId: Types.ObjectId | string, eid: string, session?: ClientSession) {
    const [r] = await this.credits.aggregate<{ cents: number }>([
      { $match: { shopperId: oid(shopperId), enterpriseId: oid(eid), kind: 'earn', status: 'active', remainingCents: { $gt: 0 }, expiresAt: { $gt: new Date() } } },
      { $group: { _id: null, cents: { $sum: '$remainingCents' } } },
    ]).session(session ?? null);
    return r?.cents ?? 0;
  }

  /** Todos os saldos do comprador (conta do comprador). */
  async balances(shopperId: Types.ObjectId | string) {
    const rows = await crossTenant(this.credits, 'conta do comprador: cashback dele em todas as lojas').aggregate<{ _id: Types.ObjectId; cents: number; next: Date }>([
      { $match: { shopperId: oid(shopperId), kind: 'earn', status: 'active', remainingCents: { $gt: 0 }, expiresAt: { $gt: new Date() } } },
      { $group: { _id: '$enterpriseId', cents: { $sum: '$remainingCents' }, next: { $min: '$expiresAt' } } },
    ]);
    if (!rows.length) return [];
    const stores = await this.stores.find({ enterpriseId: { $in: rows.map((r) => r._id) } }).select('enterpriseId slug name logo theme.accent').lean();
    const byE = new Map(stores.map((s) => [String(s.enterpriseId), s]));
    return rows.filter((r) => byE.has(String(r._id))).map((r) => { const s = byE.get(String(r._id))!; return { slug: s.slug, name: s.name, logo: s.logo, accent: s.theme?.accent ?? '#FF3D00', balanceCents: r.cents, nextExpiry: r.next }; });
  }

  /** Usa crédito no pedido (lotes que vencem antes primeiro). */
  async spendCredit(shopperId: Types.ObjectId, eid: string, orderId: Types.ObjectId, amountCents: number, session: ClientSession) {
    if (amountCents <= 0) return 0;
    const lots = await this.credits.find({ shopperId, enterpriseId: oid(eid), kind: 'earn', status: 'active', remainingCents: { $gt: 0 }, expiresAt: { $gt: new Date() } }).session(session).lean();
    const alloc = allocateCredit(lots.map((l) => ({ id: String(l._id), remainingCents: l.remainingCents, expiresAt: l.expiresAt! })), amountCents);
    if (!alloc.length) throw new UnprocessableEntityException({ statusCode: 422, code: 'CREDIT_CHANGED', message: 'Seu saldo de cashback mudou. Revise o pedido e tente de novo.' });
    for (const a of alloc) {
      const r = await this.credits.updateOne({ _id: a.id, remainingCents: { $gte: a.cents } }, { $inc: { remainingCents: -a.cents } }, { session });
      if (!r.modifiedCount) throw new UnprocessableEntityException({ statusCode: 422, code: 'CREDIT_CHANGED', message: 'Seu saldo de cashback mudou. Revise o pedido e tente de novo.' });
    }
    await this.credits.create([{ shopperId, enterpriseId: oid(eid), kind: 'spend', amountCents, orderId, allocations: alloc.map((a) => ({ id: new Types.ObjectId(a.id), cents: a.cents })) }], { session });
    return amountCents;
  }

  /** Pedido não pago (ou reembolsado): o crédito usado volta para os lotes de onde saiu. */
  async restoreCredit(orderId: Types.ObjectId, session: ClientSession) {
    const sp = await this.credits.findOneAndUpdate({ orderId, kind: 'spend', status: 'active' }, { $set: { status: 'reversed' } }, { session });
    if (!sp) return;
    for (const a of sp.allocations) await this.credits.updateOne({ _id: a.id }, { $inc: { remainingCents: a.cents } }, { session });
  }

  /** Pedido pago depois de expirar: tenta usar o crédito de novo (o cliente já pagou com o desconto). */
  async respendIfNeeded(shopperId: Types.ObjectId | null | undefined, eid: string, orderId: Types.ObjectId, amountCents: number, session: ClientSession) {
    if (!shopperId || amountCents <= 0) return;
    if (await this.credits.exists({ orderId, kind: 'spend', status: 'active' }).session(session)) return;
    try { await this.spendCredit(shopperId, eid, orderId, amountCents, session); } catch { /* saldo já usado em outro pedido: a loja absorve */ }
  }

  /** Pedido pago: o cashback vira crédito com validade (uma vez por pedido). */
  async earn(shopperId: Types.ObjectId | null | undefined, eid: string, orderId: Types.ObjectId, cents: number, expiresDays: number, session: ClientSession) {
    if (!shopperId || cents <= 0) return;
    if (await this.credits.exists({ orderId, kind: 'earn' }).session(session)) return;
    await this.credits.create([{ shopperId, enterpriseId: oid(eid), kind: 'earn', amountCents: cents, remainingCents: cents, expiresAt: new Date(Date.now() + expiresDays * 86_400_000), orderId }], { session });
  }

  /** Pedido reembolsado/cancelado depois de pago: o cashback ganho deixa de valer (o que sobrou dele). */
  async reverseEarn(orderId: Types.ObjectId, session: ClientSession) {
    await this.credits.updateOne({ orderId, kind: 'earn', status: 'active' }, { $set: { status: 'reversed', remainingCents: 0 } }, { session });
  }

}
