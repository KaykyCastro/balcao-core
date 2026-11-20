import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProductService } from '../products/product.service';
import { ProductEvent } from './schema/product-event.schema';
import { Order } from './schema/order.schema';
import { StoreService } from './store.service';
import { collaborative, interestProfile, profileSummary, rankCandidates, VISITOR_RE, type Candidate, type EventKind, type Interaction } from './recommendation.rules';
import { onlineEffectivePrice } from '../products/schema/product.schema';
import { crossTenant } from '../common/security/tenant-guard.plugin';

/** Marketplace "Lojas no Balcão": interações (ver/curtir) e recomendações, só de lojas listadas. */
@Injectable()
export class MarketplaceService {
  constructor(
    @InjectModel(ProductEvent.name) private readonly events: Model<ProductEvent>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    private readonly stores: StoreService,
    private readonly products: ProductService,
  ) {
    this.events = crossTenant(events, 'marketplace: eventos do visitante (visitorId), em todas as lojas listadas');
  }

  private check(visitorId: string) { if (!VISITOR_RE.test(visitorId)) throw new BadRequestException('Visitante inválido'); }

  /** Registra uma visualização ou curtida. Visualizações repetidas em 30 min contam uma vez. */
  async track(visitorId: string, productId: string, kind: 'view' | 'like' | 'unlike' | 'cart') {
    this.check(visitorId);
    if (!Types.ObjectId.isValid(productId)) throw new BadRequestException('Produto inválido');
    const [p] = await this.products.publicByIds([productId]);
    if (!p) throw new NotFoundException('Produto não encontrado');
    const listed = new Set((await this.stores.listedStores()).map((s) => s.enterpriseId));
    if (!listed.has(String(p.enterpriseId))) return { ok: true }; // loja fora do marketplace: não entra na recomendação
    const base = { visitorId, productId: new Types.ObjectId(productId) };
    if (kind === 'unlike') { await this.events.deleteOne({ ...base, kind: 'like' }); return { ok: true }; }
    if (kind !== 'like' && (await this.events.exists({ ...base, kind, at: { $gt: new Date(Date.now() - 30 * 60_000) } }))) return { ok: true };
    const extra = { enterpriseId: p.enterpriseId, categoryId: p.categoryId ?? null, at: new Date() };
    if (kind !== 'like') await this.events.create({ ...base, kind, ...extra });
    else await this.events.updateOne({ ...base, kind: 'like' }, { $setOnInsert: extra }, { upsert: true }).catch((e) => { if ((e as { code?: number }).code !== 11000) throw e; });
    return { ok: true };
  }

  /**
   * Vendas pagas recentes nas lojas listadas, sem nenhum dado pessoal: só o produto, a cidade da entrega
   * (ou da loja, na retirada) e quando. Alimenta os avisos "alguém de Recife comprou..." do marketplace.
   */
  async recentSales(enterpriseIds: string[], hours = 48, limit = 10) {
    if (!enterpriseIds.length) return [];
    const rows = await this.orders.find({
      enterpriseId: { $in: enterpriseIds.map((x) => new Types.ObjectId(x)) },
      status: { $in: ['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'] as ('paid')[] },
      'payment.paidAt': { $gt: new Date(Date.now() - hours * 3600_000) },
    }).sort({ 'payment.paidAt': -1 }).limit(limit).select('enterpriseId items.productId items.productName address.city address.state payment.paidAt').lean();
    return rows.filter((o) => o.items?.length).map((o) => ({
      enterpriseId: String(o.enterpriseId), productId: String(o.items[0].productId), productName: o.items[0].productName,
      city: o.address?.city ? `${o.address.city}${o.address.state ? `/${o.address.state}` : ''}` : '', at: o.payment.paidAt,
    }));
  }

  /** Apaga o histórico do visitante (retirou o consentimento). */
  async forget(visitorId: string) {
    this.check(visitorId);
    await this.events.deleteMany({ visitorId });
    return { ok: true };
  }

  /** Ids curtidos pelo visitante (para pintar o coração). */
  async likedIds(visitorId: string) {
    this.check(visitorId);
    const rows = await this.events.find({ visitorId, kind: 'like' }).sort({ at: -1 }).limit(200).select('productId').lean();
    return rows.map((r) => String(r.productId));
  }

  /** Mais vistos, curtidos e postos no carrinho nos últimos 14 dias, de todos os visitantes (o que está em alta). */
  async popularity(days = 14): Promise<Map<string, number>> {
    const rows = await this.events.aggregate<{ _id: Types.ObjectId; score: number }>([
      { $match: { at: { $gt: new Date(Date.now() - days * 864e5) } } },
      { $group: { _id: '$productId', score: { $sum: { $switch: { branches: [{ case: { $eq: ['$kind', 'like'] }, then: 4 }, { case: { $eq: ['$kind', 'cart'] }, then: 6 }], default: 1 } } } } },
      { $sort: { score: -1 } }, { $limit: 800 },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.score]));
  }

  /**
   * "Quem se interessou pelos mesmos produtos também viu": outras pessoas que tocaram nos produtos desta, e o que
   * mais elas viram/curtiram/puseram no carrinho (só ids aleatórios de visitante; nada pessoal).
   */
  private async collab(visitorId: string, mine: Set<string>) {
    if (!mine.size) return new Map<string, number>();
    const ids = [...mine].slice(0, 60).map((x) => new Types.ObjectId(x));
    const peers = (await this.events.distinct('visitorId', { productId: { $in: ids }, visitorId: { $ne: visitorId } })).slice(0, 300);
    if (!peers.length) return new Map<string, number>();
    const rows = await this.events.find({ visitorId: { $in: peers } }).sort({ at: -1 }).limit(5000).select('visitorId productId kind').lean();
    return collaborative(mine, rows.map((r) => ({ visitorId: r.visitorId, productId: String(r.productId), kind: r.kind as EventKind })));
  }

  /**
   * Recomendações. Com histórico (só com o aceite de preferências): perfil de interesse (categorias, lojas, ramos,
   * faixa de preço e palavras do que a pessoa viu, curtiu e pôs no carrinho) + colaborativo + um pouco do que está em
   * alta e do que é novo. Sem histórico, o que está em alta. `all`: vitrine completa paginada (já vistos no fim).
   * Devolve ids na ordem, quantos há no total e o resumo do perfil (para a página reordenar as faixas).
   */
  async recommend(visitorId: string | undefined, opts: { limit?: number; page?: number; all?: boolean } = {}) {
    const { limit = 12, page = 1, all = false } = opts;
    const listed = await this.stores.listedStores();
    if (!listed.length) return { ids: [] as string[], total: 0, personal: false, profile: null };
    const segOf = new Map(listed.map((s) => [s.enterpriseId, s.segment || null]));
    const [cands, pop] = await Promise.all([this.products.recommendationCandidates(listed.map((s) => s.enterpriseId)), this.popularity()]);
    type Row = Awaited<ReturnType<ProductService['recommendationCandidates']>>[number];
    const priceOf = (c: Row) => Math.round(onlineEffectivePrice(c as Parameters<typeof onlineEffectivePrice>[0]) * 100);
    const list: Candidate[] = cands.map((c) => ({
      id: String(c._id), enterpriseId: String(c.enterpriseId), categoryId: c.categoryId ? String(c.categoryId) : null,
      // Popularidade = interesse recente no marketplace + vendas de verdade (todas as vendas da loja contam).
      popularity: (pop.get(String(c._id)) ?? 0) + Math.log1p((c as { soldCount?: number }).soldCount ?? 0) * 2,
      createdAt: (c as { createdAt?: Date }).createdAt ?? null, segment: segOf.get(String(c.enterpriseId)) ?? null, priceCents: priceOf(c), name: c.name,
    }));
    const events = visitorId && VISITOR_RE.test(visitorId) ? await this.events.find({ visitorId }).sort({ at: -1 }).limit(300).lean() : [];
    const info = new Map((await this.products.recommendationSignals([...new Set(events.map((e) => String(e.productId)))])).map((p) => [String(p._id), p]));
    const history: Interaction[] = events.map((e) => {
      const p = info.get(String(e.productId));
      return { productId: String(e.productId), enterpriseId: String(e.enterpriseId), categoryId: e.categoryId ? String(e.categoryId) : null, kind: e.kind as EventKind, at: e.at, segment: segOf.get(String(e.enterpriseId)) ?? null, priceCents: p ? priceOf(p) : null, name: p?.name ?? null };
    });
    const profile = interestProfile(history);
    const personal = profile.strength > 0;
    const collab = personal ? await this.collab(visitorId!, profile.seen) : undefined;
    const ranked = rankCandidates(list, profile, { collab, excludeSeen: !all, limit: all ? list.length : limit * page, minShare: all ? 0 : 0.5 });
    const slugOf = new Map(listed.map((s) => [s.enterpriseId, s.slug]));
    const sum = personal ? profileSummary(profile) : null;
    // A página só conhece as lojas pelo endereço (slug), não pelo id da empresa.
    const summary = sum ? { ...sum, stores: sum.stores.map((id) => slugOf.get(id)).filter((x): x is string => !!x) } : null;
    return { ids: ranked.slice((page - 1) * limit, page * limit), total: ranked.length, personal, profile: summary };
  }
}
