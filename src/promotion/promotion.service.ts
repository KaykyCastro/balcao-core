import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, QueryFilter, Types } from 'mongoose';
import { Paginated } from '../common/dto/pagination-query.dto';
import { toCents } from '../common/money';
import { effectivePrice, ProductSchema } from '../products/schema/product.schema';
import { PromotionCreateDto, PromotionGroupCreateDto, PromotionGroupUpdateDto, PromotionListQueryDto, PromotionUpdateDto } from './dto/promotion.dto';
import { percentPrice, promoUnits, promotionStatus, remainingUnits } from './promotion.rules';
import { Promotion, PromotionDocument } from './schema/promotion.schema';

/** O que vai junto com o produto (tela de vendas, app): só o necessário para mostrar e calcular a prévia. */
export interface ProductPromotion { id: string; name: string; priceCents: number; limitUnits: number | null; soldUnits: number; remaining: number | null; endsAt: Date | null }

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

@Injectable()
export class PromotionService {
  constructor(
    @InjectModel(Promotion.name) private readonly promos: Model<Promotion>,
    @InjectModel(ProductSchema.name) private readonly products: Model<ProductSchema>,
  ) {}

  /** Filtro das promoções valendo agora (dentro do período, não encerradas e com unidades sobrando). */
  private activeFilter(enterpriseId: string, now = new Date()): QueryFilter<Promotion> {
    return {
      enterpriseId: new Types.ObjectId(enterpriseId), endedAt: null, startsAt: { $lte: now },
      $and: [
        { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
        { $or: [{ limitUnits: null }, { $expr: { $lt: ['$soldUnits', '$limitUnits'] } }] },
      ],
    };
  }

  /** Promoção ainda "em aberto" (ativa ou agendada) do produto, se houver. */
  private openFilter(enterpriseId: string, productId: string, now = new Date()): QueryFilter<Promotion> {
    return {
      enterpriseId: new Types.ObjectId(enterpriseId), productId: new Types.ObjectId(productId), endedAt: null,
      $and: [
        { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
        { $or: [{ limitUnits: null }, { $expr: { $lt: ['$soldUnits', '$limitUnits'] } }] },
      ],
    };
  }

  view(p: PromotionDocument | (Promotion & { _id: Types.ObjectId; createdAt?: Date })) {
    const o = 'toObject' in p ? (p as PromotionDocument).toObject() : p;
    return {
      id: String(o._id), productId: String(o.productId), productName: o.productName, productCode: o.productCode,
      name: o.name, mode: o.mode, percent: o.percent, promoPriceCents: o.promoPriceCents, regularPriceCents: o.regularPriceCents,
      limitUnits: o.limitUnits, soldUnits: o.soldUnits, remaining: remainingUnits(o),
      startsAt: o.startsAt, endsAt: o.endsAt, endedAt: o.endedAt, status: promotionStatus(o), groupId: o.groupId ? String(o.groupId) : null,
      createdAt: (o as { createdAt?: Date }).createdAt,
    };
  }

  async create(enterpriseId: string, dto: PromotionCreateDto) {
    const product = await this.products.findOne({ _id: dto.productId, enterpriseId });
    if (!product) throw new NotFoundException('Produto não encontrado');
    const regular = toCents(product.price);
    const current = toCents(effectivePrice(product));
    const promoPriceCents = dto.mode === 'percent' ? percentPrice(regular, dto.percent!) : toCents(dto.price!);
    if (promoPriceCents <= 0) throw new BadRequestException('O preço da promoção precisa ser maior que zero');
    if (promoPriceCents >= current) throw new BadRequestException(`O preço da promoção (${brl(promoPriceCents)}) precisa ser menor que o preço atual do produto (${brl(current)})`);
    const now = new Date();
    const startsAt = dto.startsAt && dto.startsAt > now ? dto.startsAt : now;
    if (dto.endsAt && dto.endsAt <= startsAt) throw new BadRequestException('O fim da promoção precisa ser depois do início');
    if (await this.promos.exists(this.openFilter(enterpriseId, dto.productId, now))) {
      throw new ConflictException('Este produto já tem uma promoção ativa ou agendada. Encerre-a antes de criar outra.');
    }
    const doc = await this.promos.create({
      enterpriseId, productId: product._id, productName: product.name, productCode: product.code,
      name: dto.name?.trim() || product.name, mode: dto.mode, percent: dto.mode === 'percent' ? dto.percent : null,
      promoPriceCents, regularPriceCents: regular, limitUnits: dto.limitUnits ?? null, soldUnits: 0,
      startsAt, endsAt: dto.endsAt ?? null, endedAt: null,
    });
    return this.view(doc);
  }

  /**
   * Promoção com vários produtos: um registro por produto (cada um com seu desconto e limite de unidades),
   * todos com o mesmo groupId, nome e período. Tudo ou nada (transação).
   */
  async createGroup(enterpriseId: string, dto: PromotionGroupCreateDto) {
    const ids = dto.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('O mesmo produto aparece duas vezes na promoção');
    const products = await this.products.find({ _id: { $in: ids.map((x) => new Types.ObjectId(x)) }, enterpriseId });
    if (products.length !== ids.length) throw new NotFoundException('Algum produto não foi encontrado');
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const now = new Date();
    const startsAt = dto.startsAt && dto.startsAt > now ? dto.startsAt : now;
    if (dto.endsAt && dto.endsAt <= startsAt) throw new BadRequestException('O fim da promoção precisa ser depois do início');
    const groupId = new Types.ObjectId();
    const docs: Record<string, unknown>[] = [];
    for (const it of dto.items) {
      const p = byId.get(it.productId)!;
      const regular = toCents(p.price);
      const current = toCents(effectivePrice(p));
      const promoPriceCents = it.mode === 'percent' ? percentPrice(regular, it.percent!) : toCents(it.price!);
      if (promoPriceCents <= 0) throw new BadRequestException(`${p.name}: o preço da promoção precisa ser maior que zero`);
      if (promoPriceCents >= current) throw new BadRequestException(`${p.name}: o preço da promoção (${brl(promoPriceCents)}) precisa ser menor que o preço atual (${brl(current)})`);
      if (await this.promos.exists(this.openFilter(enterpriseId, it.productId, now))) throw new ConflictException(`${p.name} já tem uma promoção ativa ou agendada. Tire da lista ou encerre a outra antes.`);
      docs.push({
        enterpriseId, productId: p._id, productName: p.name, productCode: p.code, name: dto.name.trim(), mode: it.mode,
        percent: it.mode === 'percent' ? it.percent : null, promoPriceCents, regularPriceCents: regular, limitUnits: it.limitUnits ?? null,
        soldUnits: 0, startsAt, endsAt: dto.endsAt ?? null, endedAt: null, groupId,
      });
    }
    const session = await this.promos.db.startSession();
    try {
      let created: PromotionDocument[] = [];
      await session.withTransaction(async () => { created = (await this.promos.insertMany(docs, { session })) as unknown as PromotionDocument[]; });
      return { groupId: String(groupId), items: created.map((d) => this.view(d)) };
    } finally {
      await session.endSession();
    }
  }

  /** Nome e fim valem para todos os produtos do grupo que ainda estão abertos. */
  async updateGroup(enterpriseId: string, groupId: string, dto: PromotionGroupUpdateDto) {
    const items = await this.promos.find({ enterpriseId, groupId: new Types.ObjectId(groupId), endedAt: null });
    if (!items.length) throw new NotFoundException('Promoção não encontrada ou já encerrada');
    for (const p of items) {
      if (dto.name !== undefined) p.name = dto.name.trim();
      if (dto.endsAt !== undefined) {
        if (dto.endsAt && dto.endsAt <= p.startsAt) throw new BadRequestException('O fim da promoção precisa ser depois do início');
        p.endsAt = dto.endsAt;
      }
    }
    await Promise.all(items.map((p) => p.save()));
    return { items: items.map((p) => this.view(p)) };
  }

  /** Encerra todos os produtos do grupo na hora. */
  async endGroup(enterpriseId: string, groupId: string) {
    const r = await this.promos.updateMany({ enterpriseId, groupId: new Types.ObjectId(groupId), endedAt: null }, { $set: { endedAt: new Date() } });
    if (!r.modifiedCount) throw new ConflictException('Promoção já encerrada');
    return { ended: r.modifiedCount };
  }

  async list(enterpriseId: string, q: PromotionListQueryDto): Promise<Paginated<ReturnType<PromotionService['view']>>> {
    const eid = new Types.ObjectId(enterpriseId); const now = new Date();
    const base: QueryFilter<Promotion> = { enterpriseId: eid, ...(q.productId ? { productId: new Types.ObjectId(q.productId) } : {}) };
    if (q.search) base.$or = [{ name: { $regex: escapeRe(q.search), $options: 'i' } }, { productName: { $regex: escapeRe(q.search), $options: 'i' } }];
    const open: QueryFilter<Promotion> = { endedAt: null, $and: [{ $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }, { $or: [{ limitUnits: null }, { $expr: { $lt: ['$soldUnits', '$limitUnits'] } }] }] };
    const filter: QueryFilter<Promotion> = q.filter === 'open' ? { ...base, ...open } : q.filter === 'closed' ? { ...base, $nor: [open] } : base;
    const [items, total] = await Promise.all([
      this.promos.find(filter).sort({ endedAt: 1, createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.promos.countDocuments(filter),
    ]);
    return { items: items.map((p) => this.view(p)), total, page: q.page, limit: q.limit };
  }

  private async get(enterpriseId: string, id: string) {
    const p = await this.promos.findOne({ _id: id, enterpriseId });
    if (!p) throw new NotFoundException('Promoção não encontrada');
    return p;
  }

  async update(enterpriseId: string, id: string, dto: PromotionUpdateDto) {
    const p = await this.get(enterpriseId, id);
    if (p.endedAt) throw new ConflictException('Promoção encerrada não pode ser alterada');
    if (dto.name !== undefined) p.name = dto.name.trim();
    if (dto.limitUnits !== undefined) {
      if (dto.limitUnits !== null && dto.limitUnits < p.soldUnits) throw new BadRequestException(`Já foram vendidas ${p.soldUnits} unidades: o limite não pode ser menor que isso`);
      p.limitUnits = dto.limitUnits;
    }
    if (dto.endsAt !== undefined) {
      if (dto.endsAt && dto.endsAt <= p.startsAt) throw new BadRequestException('O fim da promoção precisa ser depois do início');
      p.endsAt = dto.endsAt;
    }
    await p.save();
    return this.view(p);
  }

  /** Encerra na hora: o produto volta ao preço normal. */
  async end(enterpriseId: string, id: string) {
    const p = await this.promos.findOneAndUpdate({ _id: id, enterpriseId, endedAt: null }, { $set: { endedAt: new Date() } }, { returnDocument: 'after' });
    if (!p) { await this.get(enterpriseId, id); throw new ConflictException('Promoção já encerrada'); }
    return this.view(p);
  }

  /** Promoções valendo agora, por produto. */
  async activeFor(enterpriseId: string, productIds: (string | Types.ObjectId)[], session?: ClientSession): Promise<Map<string, PromotionDocument>> {
    if (!productIds.length) return new Map();
    const list = await this.promos.find({ ...this.activeFilter(enterpriseId), productId: { $in: productIds.map((x) => new Types.ObjectId(String(x))) } }).sort({ createdAt: -1 }).session(session ?? null);
    const map = new Map<string, PromotionDocument>();
    for (const p of list) if (!map.has(String(p.productId))) map.set(String(p.productId), p);
    return map;
  }

  /** Produtos com promoção valendo agora (seção "Ofertas" da vitrine). */
  async activeProductIds(enterpriseId: string): Promise<string[]> {
    const ids = await this.promos.distinct('productId', this.activeFilter(enterpriseId));
    return ids.map(String);
  }

  /** Acrescenta `promotion` aos produtos (lista, busca, mais vendidos, leitor). */
  async decorate<T extends { _id: unknown }>(enterpriseId: string, products: T[]): Promise<(T & { promotion: ProductPromotion | null })[]> {
    const plain = products.map((p) => (p && typeof (p as { toJSON?: () => T }).toJSON === 'function' ? (p as unknown as { toJSON: () => T }).toJSON() : p));
    const map = await this.activeFor(enterpriseId, plain.map((p) => p._id as Types.ObjectId));
    return plain.map((p) => {
      const pr = map.get(String(p._id));
      return { ...p, promotion: pr ? { id: String(pr._id), name: pr.name, priceCents: pr.promoPriceCents, limitUnits: pr.limitUnits, soldUnits: pr.soldUnits, remaining: remainingUnits(pr), endsAt: pr.endsAt } : null };
    });
  }

  /**
   * Reserva até `wanted` unidades no preço promocional, dentro da transação da venda.
   * Devolve quantas couberam no limite (0 = esgotou). Corrida entre vendas: a escrita condicional
   * só passa se ninguém mexeu no contador; se mexeu, relê e tenta de novo.
   */
  async consume(promo: PromotionDocument, wanted: number, session: ClientSession): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = attempt === 0 ? promo : await this.promos.findById(promo._id).session(session);
      if (!cur || promotionStatus(cur) !== 'active') return 0;
      const take = promoUnits(cur, wanted);
      if (take <= 0) return 0;
      const r = await this.promos.updateOne({ _id: cur._id, soldUnits: cur.soldUnits, endedAt: null }, { $inc: { soldUnits: take } }, { session });
      if (r.modifiedCount === 1) return take;
    }
    throw new ConflictException('Muitas vendas ao mesmo tempo nesta promoção. Tente de novo.');
  }

  /** Cancelamento de venda: as unidades voltam para a promoção (que pode reabrir se ainda estiver no período). */
  async release(promotionId: Types.ObjectId | string, units: number, session: ClientSession) {
    await this.promos.updateOne({ _id: promotionId, soldUnits: { $gte: units } }, { $inc: { soldUnits: -units } }, { session });
  }
}

const escapeRe = (s: string) => s.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
