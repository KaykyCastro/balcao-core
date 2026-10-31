import { PromotionService } from '../promotion/promotion.service';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale } from '../sale/schema/sale.schema';
import { ProductSchema } from '../products/schema/product.schema';
import { CustomerSchema } from '../customer/schema/customer.schema';
import { BILLING_TZ } from '../common/period';

const DAY = 24 * 3600_000;
/** Início do ano no fuso da loja (Fortaleza = UTC-3, sem horário de verão). */
export const yearStart = (y: number) => new Date(Date.UTC(y, 0, 1, 3, 0, 0));

/** Dias até acabar o estoque no ritmo dos últimos `windowDays` dias; null se não há venda (sem previsão). */
export function daysLeft(quantity: number, sold: number, windowDays: number): number | null {
  if (sold <= 0) return null;
  return Math.round((quantity / (sold / windowDays)) * 10) / 10;
}

@Injectable()
export class ReportService {
  constructor(
    @InjectModel(Sale.name) private readonly sales: Model<Sale>,
    @InjectModel(ProductSchema.name) private readonly products: Model<ProductSchema>,
    @InjectModel(CustomerSchema.name) private readonly customers: Model<CustomerSchema>,
    private readonly promotions: PromotionService,
  ) {}

  /** Painel da empresa: tudo calculado no banco (não depende de baixar as últimas vendas no navegador). */
  async overview(enterpriseId: string, days: number, lowStockThreshold: number) {
    const eid = new Types.ObjectId(enterpriseId);
    const from = new Date(Date.now() - days * DAY);
    const inRange = { enterpriseId: eid, createdAt: { $gte: from } };

    const [totals, byMethod, daily, top, debt, low] = await Promise.all([
      this.sales.aggregate<{ _id: string; count: number; totalCents: number; feeCents: number }>([
        { $match: inRange },
        { $group: { _id: '$status', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' }, feeCents: { $sum: '$feeCents' } } },
      ]),
      this.sales.aggregate<{ _id: string; count: number; totalCents: number }>([
        { $match: { ...inRange, status: 'completed' } },
        { $group: { _id: '$paymentMethod', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
        { $sort: { totalCents: -1 } },
      ]),
      this.sales.aggregate<{ _id: string; count: number; totalCents: number }>([
        { $match: { ...inRange, status: 'completed' } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BILLING_TZ } }, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
        { $sort: { _id: 1 } },
      ]),
      this.sales.aggregate<{ _id: { code: string; name: string }; quantity: number; totalCents: number }>([
        { $match: { ...inRange, status: 'completed' } },
        { $unwind: '$items' },
        { $group: { _id: { code: '$items.productCode', name: '$items.productName' }, quantity: { $sum: '$items.quantity' }, totalCents: { $sum: '$items.totalCents' } } },
        { $sort: { totalCents: -1 } }, { $limit: 10 },
      ]),
      this.customers.aggregate<{ cents: number; customers: number }>([
        { $match: { enterpriseId: eid, debitCents: { $gt: 0 } } },
        { $group: { _id: null, cents: { $sum: '$debitCents' }, customers: { $sum: 1 } } },
      ]),
      this.products.find({ enterpriseId: eid, trackStock: { $ne: false }, quantity: { $lte: lowStockThreshold } }).sort({ quantity: 1, name: 1 }).limit(10).select('name code quantity'),
    ]);

    const done = totals.find((t) => t._id === 'completed');
    const cancelled = totals.find((t) => t._id === 'cancelled');
    const count = done?.count ?? 0; const revenue = done?.totalCents ?? 0;
    return {
      range: { days, from, to: new Date() },
      sales: { count, revenueCents: revenue, avgTicketCents: count ? Math.round(revenue / count) : 0, cancelledCount: cancelled?.count ?? 0, feeCents: done?.feeCents ?? 0 },
      byPaymentMethod: byMethod.map((m) => ({ method: m._id, count: m.count, totalCents: m.totalCents })),
      daily: daily.map((d) => ({ date: d._id, count: d.count, totalCents: d.totalCents })),
      topProducts: top.map((t) => ({ productCode: t._id.code, productName: t._id.name, quantity: t.quantity, totalCents: t.totalCents })),
      fiado: { openCents: debt[0]?.cents ?? 0, customersWithDebt: debt[0]?.customers ?? 0 },
      lowStock: low.map((p) => ({ id: String(p._id), name: p.name, code: p.code, quantity: p.quantity })),
    };
  }

  /** Visão do ano: mês a mês (com o ano anterior para comparar), dias/horas fortes, produtos, clientes e formas de pagamento. */
  async yearly(enterpriseId: string, year: number) {
    const eid = new Types.ObjectId(enterpriseId);
    const from = yearStart(year), to = yearStart(year + 1), prevFrom = yearStart(year - 1);
    const done = { enterpriseId: eid, status: 'completed' as const };
    const tz = BILLING_TZ;
    const [months, prevMonths, weekdays, hours, days, products, pay, customers, cancelled, firstSale, itemsAgg] = await Promise.all([
      this.sales.aggregate<{ _id: number; count: number; totalCents: number }>([
        { $match: { ...done, createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: { $month: { date: '$createdAt', timezone: tz } }, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
      ]),
      this.sales.aggregate<{ _id: number; count: number; totalCents: number }>([
        { $match: { ...done, createdAt: { $gte: prevFrom, $lt: from } } },
        { $group: { _id: { $month: { date: '$createdAt', timezone: tz } }, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
      ]),
      this.sales.aggregate<{ _id: number; count: number; totalCents: number }>([
        { $match: { ...done, createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: { $dayOfWeek: { date: '$createdAt', timezone: tz } }, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
      ]),
      this.sales.aggregate<{ _id: number; count: number }>([
        { $match: { ...done, createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: { $hour: { date: '$createdAt', timezone: tz } }, count: { $sum: 1 } } },
      ]),
      this.sales.aggregate<{ _id: string; count: number; totalCents: number }>([
        { $match: { ...done, createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
        { $sort: { totalCents: -1 } }, { $limit: 1 },
      ]),
      this.sales.aggregate<{ _id: { code: string; name: string }; quantity: number; totalCents: number }>([
        { $match: { ...done, createdAt: { $gte: from, $lt: to } } },
        { $unwind: '$items' },
        { $group: { _id: { code: '$items.productCode', name: '$items.productName' }, quantity: { $sum: '$items.quantity' }, totalCents: { $sum: '$items.totalCents' } } },
        { $sort: { totalCents: -1 } }, { $limit: 10 },
      ]),
      this.sales.aggregate<{ _id: string; count: number; totalCents: number }>([
        { $match: { ...done, createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: '$paymentMethod', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
        { $sort: { totalCents: -1 } },
      ]),
      this.sales.aggregate<{ _id: Types.ObjectId; count: number; totalCents: number }>([
        { $match: { ...done, customerId: { $ne: null }, createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: '$customerId', count: { $sum: 1 }, totalCents: { $sum: '$totalCents' } } },
        { $sort: { totalCents: -1 } }, { $limit: 5 },
      ]),
      this.sales.countDocuments({ enterpriseId: eid, status: 'cancelled', createdAt: { $gte: from, $lt: to } }),
      this.sales.findOne({ enterpriseId: eid, status: 'completed' }).sort({ createdAt: 1 }).select('createdAt').lean<{ createdAt: Date }>(),
      this.sales.aggregate<{ _id: null; units: number; customers: number }>([
        { $match: { ...done, createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: null, units: { $sum: { $sum: '$items.quantity' } }, customers: { $addToSet: '$customerId' } } },
        { $project: { units: 1, customers: { $size: { $filter: { input: '$customers', as: 'c', cond: { $ne: ['$$c', null] } } } } } },
      ]),
    ]);

    const series = (rows: { _id: number; count: number; totalCents: number }[]) =>
      Array.from({ length: 12 }, (_, i) => { const r = rows.find((x) => x._id === i + 1); return { month: i + 1, count: r?.count ?? 0, totalCents: r?.totalCents ?? 0 }; });
    const cur = series(months), prev = series(prevMonths);
    const count = cur.reduce((a, m) => a + m.count, 0), revenue = cur.reduce((a, m) => a + m.totalCents, 0);
    const prevRevenue = prev.reduce((a, m) => a + m.totalCents, 0), prevCount = prev.reduce((a, m) => a + m.count, 0);
    const best = cur.reduce((b, m) => (m.totalCents > b.totalCents ? m : b), cur[0]);
    const names = customers.length ? await this.customers.find({ _id: { $in: customers.map((c) => c._id) }, enterpriseId: eid }).select('name').lean<{ _id: Types.ObjectId; name: string }[]>() : [];
    const nameOf = (id: Types.ObjectId) => names.find((n) => String(n._id) === String(id))?.name ?? 'Cliente removido';
    const dow = (n: number) => { const r = weekdays.find((w) => w._id === n); return { count: r?.count ?? 0, totalCents: r?.totalCents ?? 0 }; };
    const earliest = firstSale?.createdAt ? Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(firstSale.createdAt)) : year;
    const agg = itemsAgg[0];

    return {
      year, availableFrom: Math.min(earliest, year),
      totals: {
        count, revenueCents: revenue, avgTicketCents: count ? Math.round(revenue / count) : 0,
        unitsSold: agg?.units ?? 0, itemsPerSale: count ? Math.round(((agg?.units ?? 0) / count) * 10) / 10 : 0,
        cancelledCount: cancelled, cancelRate: count + cancelled ? cancelled / (count + cancelled) : 0,
        customersServed: agg?.customers ?? 0,
        avgPerActiveMonthCents: Math.round(revenue / Math.max(1, cur.filter((m) => m.count > 0).length)),
      },
      previousYear: { count: prevCount, revenueCents: prevRevenue, growth: prevRevenue ? (revenue - prevRevenue) / prevRevenue : null },
      months: cur.map((m, i) => ({ ...m, prevTotalCents: prev[i].totalCents, prevCount: prev[i].count })),
      bestMonth: best && best.totalCents > 0 ? { month: best.month, totalCents: best.totalCents } : null,
      bestDay: days[0] ? { date: days[0]._id, totalCents: days[0].totalCents, count: days[0].count } : null,
      // dayOfWeek do Mongo: 1 = domingo … 7 = sábado
      weekdays: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ weekday: n - 1, ...dow(n) })),
      hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hours.find((x) => x._id === h)?.count ?? 0 })),
      topProducts: products.map((t) => ({ productCode: t._id.code, productName: t._id.name, quantity: t.quantity, totalCents: t.totalCents })),
      byPaymentMethod: pay.map((m) => ({ method: m._id, count: m.count, totalCents: m.totalCents })),
      topCustomers: customers.map((c) => ({ name: nameOf(c._id), count: c.count, totalCents: c.totalCents })),
    };
  }

  /** Saúde do estoque: o que acabou, o que está acabando no ritmo atual de vendas e o que está parado. */
  async stock(enterpriseId: string, lowStockThreshold = 5) {
    const eid = new Types.ObjectId(enterpriseId);
    const W = 30, STALL = 60;
    const since = new Date(Date.now() - W * DAY), stallSince = new Date(Date.now() - STALL * DAY);
    const [prods, sold, soldStall] = await Promise.all([
      this.products.find({ enterpriseId: eid }).select('name code quantity price priceWithDiscount trackStock').lean(),
      this.sales.aggregate<{ _id: string; qty: number }>([
        { $match: { enterpriseId: eid, status: 'completed', createdAt: { $gte: since } } }, { $unwind: '$items' },
        { $group: { _id: '$items.productCode', qty: { $sum: '$items.quantity' } } },
      ]),
      this.sales.aggregate<{ _id: string }>([
        { $match: { enterpriseId: eid, status: 'completed', createdAt: { $gte: stallSince } } }, { $unwind: '$items' },
        { $group: { _id: '$items.productCode' } },
      ]),
    ]);
    const soldBy = new Map(sold.map((s) => [s._id, s.qty])); const moved = new Set(soldStall.map((s) => s._id));
    const tracked = prods.filter((p) => p.trackStock !== false);
    const price = (p: { price: number; priceWithDiscount?: number | null }) => Math.round((p.priceWithDiscount || p.price) * 100);
    const row = (p: (typeof tracked)[number]) => {
      const s = soldBy.get(p.code) ?? 0;
      return { id: String(p._id), name: p.name, code: p.code, quantity: p.quantity, sold30d: s, daysLeft: daysLeft(p.quantity, s, W) };
    };
    const out = tracked.filter((p) => p.quantity <= 0).map(row).sort((a, b) => b.sold30d - a.sold30d).slice(0, 10);
    const ending = tracked.filter((p) => p.quantity > 0).map(row)
      .filter((r) => (r.daysLeft !== null && r.daysLeft <= 14) || r.quantity <= lowStockThreshold)
      .sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.quantity - b.quantity).slice(0, 10);
    const stalled = tracked.filter((p) => p.quantity > 0 && !moved.has(p.code))
      .map((p) => ({ id: String(p._id), name: p.name, code: p.code, quantity: p.quantity, tiedUpCents: p.quantity * price(p) }))
      .sort((a, b) => b.tiedUpCents - a.tiedUpCents).slice(0, 10);
    return {
      windowDays: W, stalledDays: STALL, threshold: lowStockThreshold,
      totals: {
        products: prods.length, unlimited: prods.length - tracked.length, outOfStock: tracked.filter((p) => p.quantity <= 0).length,
        low: tracked.filter((p) => p.quantity > 0 && p.quantity <= lowStockThreshold).length,
        units: tracked.reduce((a, p) => a + p.quantity, 0),
        valueCents: tracked.reduce((a, p) => a + p.quantity * price(p), 0), // a preço de venda
        stalledCount: tracked.filter((p) => p.quantity > 0 && !moved.has(p.code)).length,
      },
      outOfStock: out, endingSoon: ending, stalled,
    };
  }

  /** Mais vendidos (últimos 90 dias) para a tela de vendas. Completa com produtos recentes se houver poucos. */
  async popular(enterpriseId: string, limit: number) {
    const eid = new Types.ObjectId(enterpriseId);
    const since = new Date(Date.now() - 90 * DAY);
    const top = await this.sales.aggregate<{ _id: Types.ObjectId; qty: number }>([
      { $match: { enterpriseId: eid, status: 'completed', createdAt: { $gte: since } } }, { $unwind: '$items' },
      { $group: { _id: '$items.productId', qty: { $sum: '$items.quantity' } } }, { $sort: { qty: -1 } }, { $limit: limit * 2 },
    ]);
    const found = await this.products.find({ enterpriseId: eid, _id: { $in: top.map((t) => t._id) } }).lean();
    const byId = new Map(found.map((p) => [String(p._id), p]));
    const list = top.map((t) => byId.get(String(t._id))).filter((p): p is NonNullable<typeof p> => !!p).slice(0, limit);
    if (list.length < limit) {
      const have = list.map((p) => p._id);
      const fill = await this.products.find({ enterpriseId: eid, _id: { $nin: have } }).sort({ createdAt: -1 }).limit(limit - list.length).lean();
      list.push(...fill);
    }
    return this.promotions.decorate(enterpriseId, list);
  }
}
