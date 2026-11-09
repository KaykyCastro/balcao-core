import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isDuplicateKeyError } from '../common/mongo';
import { ProductService } from '../products/product.service';
import { StorageService } from '../storage/storage.service';
import { OrderService } from './order.service';
import { canReview, distribution, MAX_REVIEW_PHOTOS, reviewerName, summarize } from './review.rules';
import { Review } from './schema/review.schema';

type ReviewDoc = Review & { _id: Types.ObjectId; createdAt?: Date };
const oid = (x: string | Types.ObjectId) => (typeof x === 'string' ? new Types.ObjectId(x) : x);

/** Avaliações com estrelas, comentário e fotos. Só quem comprou avalia (pelo link do pedido pago). */
@Injectable()
export class ReviewService {
  constructor(
    @InjectModel(Review.name) private readonly reviews: Model<Review>,
    private readonly orders: OrderService,
    private readonly products: ProductService,
    private readonly storage: StorageService,
  ) {}

  private present(r: ReviewDoc, admin = false) {
    return {
      id: String(r._id), name: r.name, rating: r.rating, text: r.text, photos: r.photos, reply: r.reply, repliedAt: r.repliedAt, createdAt: r.createdAt,
      ...(admin ? { productId: String(r.productId), orderId: String(r.orderId), hidden: r.hidden } : {}),
    };
  }

  /** Recalcula a média e a quantidade do produto (só avaliações visíveis). */
  private async recompute(eid: Types.ObjectId, productId: Types.ObjectId) {
    const rows = await this.reviews.find({ enterpriseId: eid, productId, hidden: false }).select('rating').lean();
    const s = summarize(rows.map((r) => r.rating));
    await this.products.setRating(String(eid), String(productId), s.avg, s.count);
  }

  // ------------------------------------------------------------------ comprador (pelo link do pedido)

  private async reviewableOrder(slug: string, orderId: string, t: string) {
    const o = await this.orders.byToken(slug, orderId, t);
    if (!canReview(o.status)) throw new UnprocessableEntityException({ statusCode: 422, code: 'NOT_REVIEWABLE', message: 'Você pode avaliar depois que o pagamento for aprovado.' });
    return o;
  }

  /** O que dá para avaliar neste pedido e o que já foi avaliado. */
  async forOrder(slug: string, orderId: string, t: string) {
    const o = await this.orders.byToken(slug, orderId, t);
    const done = (await this.reviews.find({ orderId: o._id }).lean()) as ReviewDoc[];
    const seen = new Set<string>();
    const items = o.items.filter((i) => { const k = String(i.productId); if (seen.has(k)) return false; seen.add(k); return true; })
      .map((i) => { const r = done.find((x) => String(x.productId) === String(i.productId)); return { productId: String(i.productId), name: i.productName, review: r ? this.present(r) : null }; });
    return { open: canReview(o.status), items };
  }

  async create(slug: string, orderId: string, t: string, d: { productId: string; rating: number; text?: string; photos?: string[] }) {
    const o = await this.reviewableOrder(slug, orderId, t);
    if (!o.items.some((i) => String(i.productId) === d.productId)) throw new NotFoundException('Este produto não está no pedido');
    const eid = String(o.enterpriseId);
    const photos = (await this.storage.resolveMany(eid, 'review', (d.photos ?? []).slice(0, MAX_REVIEW_PHOTOS))).filter(Boolean);
    try {
      const r = await this.reviews.create({ enterpriseId: o.enterpriseId, productId: oid(d.productId), orderId: o._id, shopperId: o.shopperId ?? null, name: reviewerName(o.customer.name), rating: d.rating, text: (d.text ?? '').trim(), photos });
      await this.recompute(o.enterpriseId, oid(d.productId));
      return this.present(r.toObject() as ReviewDoc);
    } catch (e) {
      if (isDuplicateKeyError(e)) { await this.storage.release(eid, photos); throw new ConflictException('Você já avaliou este produto neste pedido'); }
      throw e;
    }
  }

  /** Foto da avaliação: URL assinada para o comprador enviar direto (fica na pasta da loja). */
  async presignPhoto(slug: string, orderId: string, t: string, contentType: string, size: number) {
    const o = await this.reviewableOrder(slug, orderId, t);
    return this.storage.presign(String(o.enterpriseId), 'review', contentType, size);
  }
  async completePhoto(slug: string, orderId: string, t: string, uploadId: string) {
    const o = await this.reviewableOrder(slug, orderId, t);
    return this.storage.complete(uploadId, (owner) => owner === String(o.enterpriseId));
  }

  // ------------------------------------------------------------------ vitrine

  async publicList(eid: string, productId: string, page = 1, limit = 10) {
    const filter = { enterpriseId: oid(eid), productId: oid(productId), hidden: false };
    const [rows, all] = await Promise.all([
      this.reviews.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.reviews.find(filter).select('rating photos').lean(),
    ]);
    const ratings = all.map((r) => r.rating);
    return { ...summarize(ratings), distribution: distribution(ratings), withPhotos: all.filter((r) => r.photos?.length).length, items: (rows as ReviewDoc[]).map((r) => this.present(r)), page, total: all.length };
  }

  /** Avaliações da loja inteira (mural da vitrine): resumo de todas as visíveis e as mais recentes, com foto primeiro se pedido. */
  async publicStore(eid: string, q: { photos?: boolean; limit?: number }) {
    const limit = Math.min(24, Math.max(1, q.limit ?? 10));
    const base = { enterpriseId: oid(eid), hidden: false };
    const [rows, all] = await Promise.all([
      this.reviews.find(q.photos ? { ...base, 'photos.0': { $exists: true } } : base).sort({ createdAt: -1 }).limit(limit).lean(),
      this.reviews.find(base).select('rating').lean(),
    ]);
    const names = new Map((await this.products.publicByIds((rows as ReviewDoc[]).map((r) => String(r.productId)))).map((p) => [String(p._id), p.name]));
    return {
      ...summarize(all.map((r) => r.rating)),
      items: (rows as ReviewDoc[]).map((r) => ({ ...this.present(r), productId: String(r.productId), productName: names.get(String(r.productId)) ?? '' })),
    };
  }

  // ------------------------------------------------------------------ lojista

  async merchantList(eid: string, page = 1, limit = 30) {
    const rows = (await this.reviews.find({ enterpriseId: oid(eid) }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean()) as ReviewDoc[];
    const names = new Map((await this.products.publicByIds(rows.map((r) => String(r.productId)))).map((p) => [String(p._id), p.name]));
    return { items: rows.map((r) => ({ ...this.present(r, true), productName: names.get(String(r.productId)) ?? 'Produto removido' })), total: await this.reviews.countDocuments({ enterpriseId: oid(eid) }), page };
  }

  async moderate(eid: string, id: string, d: { hidden?: boolean; reply?: string }) {
    const set: Record<string, unknown> = {};
    if (d.hidden !== undefined) set.hidden = d.hidden;
    if (d.reply !== undefined) { set.reply = d.reply.trim(); set.repliedAt = d.reply.trim() ? new Date() : null; }
    const r = await this.reviews.findOneAndUpdate({ _id: id, enterpriseId: oid(eid) }, { $set: set }, { new: true }).lean();
    if (!r) throw new NotFoundException('Avaliação não encontrada');
    if (d.hidden !== undefined) await this.recompute(r.enterpriseId, r.productId);
    return this.present(r as ReviewDoc, true);
  }
}
