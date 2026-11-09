import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProductService } from '../products/product.service';
import { ProductEvent } from './schema/product-event.schema';
import { Order } from './schema/order.schema';
import { StoreService } from './store.service';
import { interestProfile, rankCandidates, VISITOR_RE, type Interaction } from './recommendation.rules';
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
  async track(visitorId: string, productId: string, kind: 'view' | 'like' | 'unlike') {
    this.check(visitorId);
    if (!Types.ObjectId.isValid(productId)) throw new BadRequestException('Produto inválido');
    const [p] = await this.products.publicByIds([productId]);
    if (!p) throw new NotFoundException('Produto não encontrado');
    const listed = new Set((await this.stores.listedStores()).map((s) => s.enterpriseId));
    if (!listed.has(String(p.enterpriseId))) return { ok: true }; // loja fora do marketplace: não entra na recomendação
    const base = { visitorId, productId: new Types.ObjectId(productId) };
    if (kind === 'unlike') { await this.events.deleteOne({ ...base, kind: 'like' }); return { ok: true }; }
    if (kind === 'view' && (await this.events.exists({ ...base, kind: 'view', at: { $gt: new Date(Date.now() - 30 * 60_000) } }))) return { ok: true };
    const extra = { enterpriseId: p.enterpriseId, categoryId: p.categoryId ?? null, at: new Date() };
    if (kind === 'view') await this.events.create({ ...base, kind, ...extra });
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

  /** Mais vistos e curtidos nos últimos 14 dias, de todos os visitantes (o que está em alta). */
  async popularity(days = 14): Promise<Map<string, number>> {
    const rows = await this.events.aggregate<{ _id: Types.ObjectId; score: number }>([
      { $match: { at: { $gt: new Date(Date.now() - days * 864e5) } } },
      { $group: { _id: '$productId', score: { $sum: { $cond: [{ $eq: ['$kind', 'like'] }, 4, 1] } } } },
      { $sort: { score: -1 } }, { $limit: 500 },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.score]));
  }

  /**
   * Recomendações: com histórico, produtos novos para o visitante nas categorias e lojas de que ele mais gosta;
   * sem histórico (ou sem consentimento), o que está em alta. Devolve ids na ordem.
   */
  async recommend(visitorId: string | undefined, limit = 12): Promise<{ ids: string[]; personal: boolean }> {
    const listed = await this.stores.listedStores();
    if (!listed.length) return { ids: [], personal: false };
    const [cands, pop] = await Promise.all([this.products.recommendationCandidates(listed.map((s) => s.enterpriseId)), this.popularity()]);
    const list = cands.map((c) => ({ id: String(c._id), enterpriseId: String(c.enterpriseId), categoryId: c.categoryId ? String(c.categoryId) : null, popularity: pop.get(String(c._id)) ?? 0 }));
    const history = visitorId && VISITOR_RE.test(visitorId)
      ? (await this.events.find({ visitorId }).sort({ at: -1 }).limit(200).lean()).map((e): Interaction => ({ productId: String(e.productId), enterpriseId: String(e.enterpriseId), categoryId: e.categoryId ? String(e.categoryId) : null, kind: e.kind, at: e.at }))
      : [];
    if (history.length) return { ids: rankCandidates(list, interestProfile(history), limit), personal: true };
    const trending = [...list].sort((a, b) => b.popularity - a.popularity);
    return { ids: rankCandidates(trending, interestProfile([]), limit), personal: false };
  }
}
