import { StorageService } from '../storage/storage.service';
import { OptionsError, sanitizeOptions, type OptionGroup } from './options.rules';
import { removedUrls } from '../storage/storage.rules';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, QueryFilter, Model, Types } from 'mongoose';

import { ProductSchema, ProductDocument } from './schema/product.schema';
import { ProductCreateDto } from './dto/product-create.dto';
import { ProductUpdateDto } from './dto/product-update.dto';
import { CategoryService } from '../category/category.service';
import { PaginationQueryDto, Paginated } from '../common/dto/pagination-query.dto';
import { escapeRegex, isDuplicateKeyError } from '../common/mongo';
import { round2 } from '../common/money';
import { crossTenant } from '../common/security/tenant-guard.plugin';

/** Fotos de um produto; produtos antigos só têm a capa. */
export function imagesOf(p: { image?: string | null; images?: string[] | null }): string[] {
  return p.images?.length ? p.images : p.image ? [p.image] : [];
}
function withImages<T extends { toJSON?: () => any; image?: string; images?: string[] }>(doc: T) {
  const json = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
  return { ...json, images: imagesOf(json) };
}

/** Adicionais validados; erro de regra vira 400 com a mensagem pronta. */
function optionsOrThrow(raw: unknown) {
  try { return sanitizeOptions(raw ?? []); }
  catch (e) { if (e instanceof OptionsError) throw new BadRequestException({ statusCode: 400, code: 'OPTIONS_INVALID', message: e.message }); throw e; }
}

@Injectable()
export class ProductService {
  constructor(
    @InjectModel(ProductSchema.name) private readonly productModel: Model<ProductSchema>,
    private readonly categoryService: CategoryService,
    private readonly storage: StorageService,
  ) {}

  async create(enterpriseId: string, dto: ProductCreateDto): Promise<ProductDocument> {
    await this.categoryService.findCategoryById(enterpriseId, dto.categoryId);

    const priceWithDiscount =
      dto.priceWithDiscount ??
      (dto.discountPercentage ? round2(dto.price * (1 - dto.discountPercentage / 100)) : 0);

    try {
      const trackStock = dto.trackStock !== false;
      // Fotos: só URLs do R2 desta empresa (ou https externo); base64 de cliente antigo sobe para o R2 aqui.
      const images = (await this.storage.resolveMany(enterpriseId, 'product', dto.images ?? (dto.image ? [dto.image] : []))).filter(Boolean);
      const created = await this.productModel.create({
        ...dto,
        options: optionsOrThrow(dto.options),
        images, image: images[0] ?? '',
        trackStock,
        quantity: trackStock ? dto.quantity ?? 0 : 0,
        description: dto.description ?? '',
        priceWithDiscount,
        enterpriseId,
      });
      return withImages(created);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe produto com esse código');
      throw e;
    }
  }

  async list(
    enterpriseId: string,
    q: PaginationQueryDto & { categoryId?: string },
  ): Promise<Paginated<ProductDocument>> {
    const filter: QueryFilter<ProductSchema> = { enterpriseId };
    if (q.categoryId) filter.categoryId = q.categoryId;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ name: rx }, { code: rx }];
    }
    const [items, total] = await Promise.all([
      this.productModel.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.productModel.countDocuments(filter),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async getProductById(enterpriseId: string, id: string): Promise<ProductDocument> {
    const product = await this.productModel.findOne({ _id: id, enterpriseId });
    if (!product) throw new NotFoundException('Produto não encontrado');
    return product;
  }

  /** Produto com todas as fotos (tela de edição). */
  async getFull(enterpriseId: string, id: string) {
    const product = await this.productModel.findOne({ _id: id, enterpriseId }).select('+images');
    if (!product) throw new NotFoundException('Produto não encontrado');
    return withImages(product);
  }

  async update(enterpriseId: string, id: string, dto: ProductUpdateDto): Promise<ProductDocument> {
    if (dto.categoryId) await this.categoryService.findCategoryById(enterpriseId, dto.categoryId);

    const set: Record<string, unknown> = { ...dto };
    if (dto.options !== undefined) set.options = optionsOrThrow(dto.options);
    else delete set.options;
    // Fotos: `images` manda a lista inteira; `image` sozinho (app antigo) troca só a capa e mantém as outras.
    let before: string[] = [];
    if (dto.images !== undefined || dto.image !== undefined) {
      const cur = await this.productModel.findOne({ _id: id, enterpriseId }).select('+images image').lean();
      if (!cur) throw new NotFoundException('Produto não encontrado');
      before = imagesOf(cur);
      const next = dto.images !== undefined ? dto.images : dto.image ? [dto.image, ...before.slice(1)] : before.slice(1);
      set.images = (await this.storage.resolveMany(enterpriseId, 'product', next)).filter(Boolean);
      set.image = (set.images as string[])[0] ?? '';
    }
    if (dto.trackStock === false) set.quantity = 0; // ilimitado: não guarda saldo
    // Só percentual enviado: recalcula o preço com desconto a partir do preço (novo ou atual).
    if (dto.discountPercentage !== undefined && dto.priceWithDiscount === undefined) {
      const price = dto.price ?? (await this.getProductById(enterpriseId, id)).price;
      set.priceWithDiscount = dto.discountPercentage ? round2(price * (1 - dto.discountPercentage / 100)) : 0;
    }

    try {
      const updated = await this.productModel.findOneAndUpdate(
        { _id: id, enterpriseId },
        { $set: set },
        { returnDocument: 'after', runValidators: true },
      ).select('+images');
      if (!updated) throw new NotFoundException('Produto não encontrado');
      // Fotos que saíram do produto: apaga do R2.
      if (set.images) await this.storage.release(enterpriseId, removedUrls(before, set.images as string[]));
      return withImages(updated);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe produto com esse código');
      throw e;
    }
  }

  async delete(enterpriseId: string, id: string): Promise<void> {
    const product = await this.productModel.findOneAndDelete({ _id: id, enterpriseId }).select('+images');
    if (!product) throw new NotFoundException('Produto não encontrado');
    await this.storage.release(enterpriseId, imagesOf(product));
  }

  /**
   * Baixa atômica de estoque: só decrementa se houver quantidade suficiente.
   * Produto com estoque ilimitado (trackStock=false) não baixa nada. Devolve se o estoque foi movimentado.
   */
  async decreaseQuantity(enterpriseId: string, id: string, quantity: number, session?: ClientSession): Promise<{ tracked: boolean }> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new UnprocessableEntityException('Quantidade deve ser um inteiro positivo');
    const updated = await this.productModel.findOneAndUpdate(
      { _id: id, enterpriseId, trackStock: { $ne: false }, quantity: { $gte: quantity } },
      { $inc: { quantity: -quantity } },
      { returnDocument: 'after', session },
    );
    if (updated) return { tracked: true };
    const p = await this.productModel.findOne({ _id: id, enterpriseId }).select('trackStock name').session(session ?? null);
    if (!p) throw new NotFoundException('Produto não encontrado');
    if (p.trackStock === false) return { tracked: false };
    throw new ConflictException(`Estoque insuficiente: ${p.name}`);
  }

  /** Repõe estoque (cancelamento). Só mexe em produto que controla estoque. */
  async increaseQuantity(enterpriseId: string, id: string, quantity: number, session?: ClientSession) {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new UnprocessableEntityException('Quantidade deve ser um inteiro positivo');
    // Produto apagado depois da venda, ou que passou a ser ilimitado: não há o que repor, nem deve impedir o cancelamento.
    return this.productModel.findOneAndUpdate({ _id: id, enterpriseId, trackStock: { $ne: false } }, { $inc: { quantity } }, { returnDocument: 'after', session });
  }

  /** Busca exata por código de barras/código interno (uso do leitor no PDV). */
  async findByCode(enterpriseId: string, code: string): Promise<ProductDocument> {
    const product = await this.productModel.findOne({ enterpriseId, code: code.trim() });
    if (!product) throw new NotFoundException('Nenhum produto com esse código');
    return product;
  }

  /** Produtos que controlam estoque e estão no limite ou abaixo (ordem: mais crítico primeiro). */
  lowStock(enterpriseId: string, threshold: number, limit = 50) {
    return this.productModel.find({ enterpriseId, trackStock: { $ne: false }, quantity: { $lte: threshold } }).sort({ quantity: 1, name: 1 }).limit(limit);
  }

  // ------------------------------------------------------------------ loja online

  /** Liga/desliga produtos na loja online. `ids` vazio + all = todos os produtos da empresa. */
  async setShowOnline(enterpriseId: string, ids: string[] | 'all', show: boolean): Promise<number> {
    const filter = ids === 'all' ? { enterpriseId } : { enterpriseId, _id: { $in: ids } };
    const r = await this.productModel.updateMany(filter, { $set: { showOnline: show } });
    return r.modifiedCount;
  }

  /**
   * Vitrine: só produtos publicados. Esgotados aparecem (marcados), para a loja não parecer vazia.
   * sort: relevance (com estoque primeiro) | price_asc | price_desc | name | new | sold (mais vendidos). Preço = o da loja online.
   * offers: só produtos com desconto, preço online menor que o do balcão ou promoção ativa (`promoIds`).
   */
  async publicList(enterpriseIds: string[], q: { search?: string; categoryId?: string; ids?: string[]; page: number; limit: number; inStock?: boolean; sort?: string; offers?: boolean; promoIds?: string[]; lowStock?: boolean }) {
    const and: Record<string, unknown>[] = [{ enterpriseId: { $in: enterpriseIds.map((x) => new Types.ObjectId(x)) } }, { showOnline: { $ne: false } }];
    if (q.categoryId) and.push({ categoryId: new Types.ObjectId(q.categoryId) });
    if (q.ids?.length) and.push({ _id: { $in: q.ids.map((x) => new Types.ObjectId(x)) } });
    if (q.search?.trim()) and.push({ name: { $regex: escapeRegex(q.search.trim().slice(0, 60)), $options: 'i' } });
    if (q.inStock) and.push({ $or: [{ trackStock: false }, { quantity: { $gt: 0 } }] });
    // "Últimas unidades": controla estoque e tem de 1 a 3.
    if (q.lowStock) and.push({ trackStock: { $ne: false }, quantity: { $gte: 1, $lte: 3 } });
    if (q.offers) and.push({ $or: [
      { priceWithDiscount: { $gt: 0 } },
      { $expr: { $and: [{ $gt: ['$onlinePrice', 0] }, { $lt: ['$onlinePrice', '$price'] }] } },
      ...(q.promoIds?.length ? [{ _id: { $in: q.promoIds.map((x) => new Types.ObjectId(x)) } }] : []),
    ] });
    const eff = { $cond: [{ $gt: [{ $ifNull: ['$onlinePrice', 0] }, 0] }, '$onlinePrice', { $cond: [{ $gt: [{ $ifNull: ['$priceWithDiscount', 0] }, 0] }, '$priceWithDiscount', '$price'] }] };
    const inStock = { $cond: [{ $or: [{ $eq: ['$trackStock', false] }, { $gt: ['$quantity', 0] }] }, 1, 0] };
    const sort: Record<string, 1 | -1> = q.sort === 'price_asc' ? { _eff: 1, name: 1 } : q.sort === 'price_desc' ? { _eff: -1, name: 1 } : q.sort === 'name' ? { name: 1 } : q.sort === 'new' ? { createdAt: -1 } : q.sort === 'sold' ? { soldCount: -1, createdAt: -1 } : { _stock: -1, updatedAt: -1, name: 1 };
    const match = { $and: and };
    const [items, total] = await Promise.all([
      this.productModel.aggregate([{ $match: match }, { $addFields: { _eff: eff, _stock: inStock, _photos: { $size: { $ifNull: ['$images', []] } } } }, { $sort: sort }, { $skip: (q.page - 1) * q.limit }, { $limit: q.limit }, { $project: { _eff: 0, _stock: 0, images: 0 } }]),
      this.productModel.countDocuments(match),
    ]);
    return { items: items as (ProductSchema & { _id: Types.ObjectId; enterpriseId: Types.ObjectId })[], total, page: q.page, limit: q.limit };
  }

  /** Média e quantidade de avaliações (ReviewService). */
  async setRating(enterpriseId: string, id: string, avg: number, count: number) {
    await this.productModel.updateOne({ _id: id, enterpriseId }, { $set: { ratingAvg: avg, ratingCount: count } });
  }

  /** Unidades vendidas por produto (SoldCountScheduler), em lote. */
  async setSoldCounts(counts: { id: Types.ObjectId; sold: number }[]) {
    for (let i = 0; i < counts.length; i += 500) {
      const part = counts.slice(i, i + 500);
      if (part.length) await this.productModel.bulkWrite(part.map((c) => ({ updateOne: { filter: { _id: c.id }, update: { $set: { soldCount: c.sold } } } })));
    }
  }

  /** Produtos novos (cadastrados há pouco) das lojas dadas, para os avisos do marketplace. */
  async recentPublic(enterpriseIds: string[], since: Date, limit = 6) {
    if (!enterpriseIds.length) return [];
    return this.productModel.find({ enterpriseId: { $in: enterpriseIds.map((x) => new Types.ObjectId(x)) }, showOnline: { $ne: false }, createdAt: { $gt: since }, $or: [{ trackStock: false }, { quantity: { $gt: 0 } }] })
      .select('name image enterpriseId createdAt').sort({ createdAt: -1 }).limit(limit).lean();
  }

  /** Produtos visíveis por id (marketplace: recomendações e curtidas), sem as fotos extras. */
  async publicByIds(ids: string[]) {
    const ok = ids.filter((x) => Types.ObjectId.isValid(x)).map((x) => new Types.ObjectId(x));
    if (!ok.length) return [];
    const rows = await crossTenant(this.productModel, 'vitrine: produtos publicados escolhidos por id').find({ _id: { $in: ok }, showOnline: { $ne: false } }).select('-images').lean();
    const pos = new Map(ids.map((x, i) => [x, i]));
    return (rows as (ProductSchema & { _id: Types.ObjectId; enterpriseId: Types.ObjectId })[]).sort((a, b) => (pos.get(String(a._id)) ?? 0) - (pos.get(String(b._id)) ?? 0));
  }

  /** Candidatos para recomendar: em estoque e só das lojas listadas no marketplace (a preferência só ordena). */
  async recommendationCandidates(listedEnterpriseIds: string[], limit = 300) {
    if (!listedEnterpriseIds.length) return [];
    return this.productModel.find({ enterpriseId: { $in: listedEnterpriseIds.map((x) => new Types.ObjectId(x)) }, showOnline: { $ne: false }, $or: [{ trackStock: false }, { quantity: { $gt: 0 } }] })
      .select('_id enterpriseId categoryId createdAt').sort({ updatedAt: -1 }).limit(limit).lean();
  }

  /** Produtos visíveis na loja online para o sitemap (só id e data da última mudança). */
  async sitemapEntries(enterpriseId: string, max = 5000): Promise<{ id: string; updatedAt: Date | null }[]> {
    const rows = await this.productModel.find({ enterpriseId: new Types.ObjectId(enterpriseId), showOnline: { $ne: false } }).select('_id updatedAt').sort({ updatedAt: -1 }).limit(max).lean();
    return rows.map((r) => ({ id: String(r._id), updatedAt: (r as unknown as { updatedAt?: Date }).updatedAt ?? null }));
  }

  /**
   * Biblioteca de opções da loja: os grupos de opções que já existem nos produtos, sem repetir (mesmo nome e mesmas
   * escolhas = um só), com quantos produtos usam. Serve para o lojista reaproveitar "Cor", "Tecido"… num produto novo.
   */
  async optionLibrary(enterpriseId: string) {
    const rows = await this.productModel.find({ enterpriseId: new Types.ObjectId(enterpriseId), 'options.0': { $exists: true } }).select('name options').sort({ updatedAt: -1 }).limit(300).lean();
    const seen = new Map<string, { group: OptionGroup; products: number; example: string }>();
    for (const r of rows) {
      for (const g of (r.options ?? []) as OptionGroup[]) {
        const key = `${g.name.trim().toLowerCase()}|${g.items.map((i) => `${i.name.trim().toLowerCase()}:${i.priceCents}`).join(',')}|${g.min}|${g.max}|${g.repeat}|${g.pricing}`;
        const cur = seen.get(key);
        if (cur) cur.products++; else seen.set(key, { group: g, products: 1, example: r.name });
      }
    }
    return { items: [...seen.values()].sort((a, b) => b.products - a.products).slice(0, 60) };
  }

  async publicGet(enterpriseId: string, id: string) {
    const p = await this.productModel.findOne({ _id: id, enterpriseId, showOnline: { $ne: false } }).select('+images').lean();
    if (!p) throw new NotFoundException('Produto não encontrado');
    return { ...p, images: imagesOf(p) };
  }

  /** Produtos de uma empresa por id (checkout). Ignora os que não estão publicados. */
  publicMany(enterpriseId: string, ids: string[]) {
    return this.productModel.find({ _id: { $in: ids }, enterpriseId, showOnline: { $ne: false } }).lean();
  }

  /** Produto com foto mais recente de cada categoria (capa das categorias na vitrine). Só ids: a imagem vem pela rota de imagem. */
  async coverByCategory(enterpriseId: string): Promise<Map<string, string>> {
    const rows = await this.productModel.aggregate<{ _id: unknown; pid: unknown }>([
      { $match: { enterpriseId: new Types.ObjectId(enterpriseId), showOnline: { $ne: false }, image: { $nin: ['', null] } } },
      { $sort: { updatedAt: -1 } },
      { $group: { _id: '$categoryId', pid: { $first: '$_id' } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), String(r.pid)]));
  }

  /** Quantos produtos publicados cada empresa tem (diretório de lojas). */
  async countOnline(enterpriseIds: string[]): Promise<Map<string, number>> {
    const rows = await this.productModel.aggregate<{ _id: unknown; n: number }>([
      { $match: { enterpriseId: { $in: enterpriseIds.map((x) => new Types.ObjectId(x)) }, showOnline: { $ne: false } } },
      { $group: { _id: '$enterpriseId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
}
