import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, QueryFilter, Model, Types } from 'mongoose';

import { ProductSchema, ProductDocument } from './schema/product.schema';
import { ProductCreateDto } from './dto/product-create.dto';
import { ProductUpdateDto } from './dto/product-update.dto';
import { CategoryService } from '../category/category.service';
import { PaginationQueryDto, Paginated } from '../common/dto/pagination-query.dto';
import { escapeRegex, isDuplicateKeyError } from '../common/mongo';
import { round2 } from '../common/money';

@Injectable()
export class ProductService {
  constructor(
    @InjectModel(ProductSchema.name) private readonly productModel: Model<ProductSchema>,
    private readonly categoryService: CategoryService,
  ) {}

  async create(enterpriseId: string, dto: ProductCreateDto): Promise<ProductDocument> {
    await this.categoryService.findCategoryById(enterpriseId, dto.categoryId);

    const priceWithDiscount =
      dto.priceWithDiscount ??
      (dto.discountPercentage ? round2(dto.price * (1 - dto.discountPercentage / 100)) : 0);

    try {
      const trackStock = dto.trackStock !== false;
      return await this.productModel.create({
        ...dto,
        trackStock,
        quantity: trackStock ? dto.quantity ?? 0 : 0,
        description: dto.description ?? '',
        priceWithDiscount,
        enterpriseId,
      });
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

  async update(enterpriseId: string, id: string, dto: ProductUpdateDto): Promise<ProductDocument> {
    if (dto.categoryId) await this.categoryService.findCategoryById(enterpriseId, dto.categoryId);

    const set: Record<string, unknown> = { ...dto };
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
      );
      if (!updated) throw new NotFoundException('Produto não encontrado');
      return updated;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe produto com esse código');
      throw e;
    }
  }

  async delete(enterpriseId: string, id: string): Promise<void> {
    const product = await this.productModel.findOneAndDelete({ _id: id, enterpriseId });
    if (!product) throw new NotFoundException('Produto não encontrado');
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

  /** Vitrine: só produtos publicados. Esgotados aparecem (marcados), para a loja não parecer vazia. */
  async publicList(enterpriseIds: string[], q: { search?: string; categoryId?: string; page: number; limit: number; inStock?: boolean }) {
    const filter: Record<string, unknown> = { enterpriseId: { $in: enterpriseIds }, showOnline: { $ne: false } };
    if (q.categoryId) filter.categoryId = q.categoryId;
    if (q.search?.trim()) filter.name = { $regex: escapeRegex(q.search.trim().slice(0, 60)), $options: 'i' };
    if (q.inStock) filter.$or = [{ trackStock: false }, { quantity: { $gt: 0 } }];
    const [items, total] = await Promise.all([
      this.productModel.find(filter).sort({ quantity: -1, name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      this.productModel.countDocuments(filter),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async publicGet(enterpriseId: string, id: string) {
    const p = await this.productModel.findOne({ _id: id, enterpriseId, showOnline: { $ne: false } }).lean();
    if (!p) throw new NotFoundException('Produto não encontrado');
    return p;
  }

  /** Produtos de uma empresa por id (checkout). Ignora os que não estão publicados. */
  publicMany(enterpriseId: string, ids: string[]) {
    return this.productModel.find({ _id: { $in: ids }, enterpriseId, showOnline: { $ne: false } }).lean();
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
