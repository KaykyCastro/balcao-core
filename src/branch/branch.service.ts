import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { trialEnd } from '../billing/billing.rules';
import { CategorySchema } from '../category/schema/category.schema';
import { escapeRegex, isDuplicateKeyError } from '../common/mongo';
import { crossTenant } from '../common/security/tenant-guard.plugin';
import { EnterpriseSchema } from '../enterprise/schema/enterprise.schema';
import { ProductSchema } from '../products/schema/product.schema';
import { Sale } from '../sale/schema/sale.schema';
import { Staff } from '../staff/schema/staff.schema';
import { StorageService } from '../storage/storage.service';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { webSessionLife } from '../auth/session-cookie';
import { BranchError, MAX_BRANCHES, branchEmail, branchName, branchTrialEnd, importPlan, rootOf } from './branch.rules';

type Ent = { _id: Types.ObjectId; name: string; parentId?: Types.ObjectId | null; tokenVersion?: number; status?: string; staff?: unknown };
const DAY = 86_400_000;
/** Início do dia/mês de Brasília (UTC−3). */
const brStart = (d = new Date()) => { const x = new Date(d.getTime() - 3 * 3_600_000); x.setUTCHours(3, 0, 0, 0); return x; };
const monthStart = (d = new Date()) => { const x = new Date(d.getTime() - 3 * 3_600_000); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1, 3)); };

/**
 * Filiais (regras em branch.rules.ts). Os modelos de loja são "entre lojas" de propósito, SEMPRE filtrados pelas
 * lojas do grupo de quem pediu (matriz + filiais dela): nunca chega a outra empresa.
 */
@Injectable()
export class BranchService {
  private readonly log = new Logger('Filiais');
  private readonly products: Model<ProductSchema>;
  private readonly categories: Model<CategorySchema>;
  private readonly sales: Model<Sale>;
  private readonly staff: Model<Staff>;

  constructor(
    @InjectModel('EnterpriseSchema') private readonly enterprises: Model<EnterpriseSchema>,
    @InjectModel(ProductSchema.name) products: Model<ProductSchema>,
    @InjectModel(CategorySchema.name) categories: Model<CategorySchema>,
    @InjectModel(Sale.name) sales: Model<Sale>,
    @InjectModel(Staff.name) staff: Model<Staff>,
    private readonly storage: StorageService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly enterpriseService: EnterpriseService,
  ) {
    const why = 'filiais: só as lojas do grupo de quem pediu (matriz + filiais)';
    this.products = crossTenant(products, why);
    this.categories = crossTenant(categories, why);
    this.sales = crossTenant(sales, why);
    this.staff = crossTenant(staff, why);
  }

  private fail(e: unknown): never {
    if (e instanceof BranchError) {
      const body = { statusCode: e.status, code: e.code, message: e.message };
      if (e.status === 400) throw new BadRequestException(body);
      if (e.status === 403) throw new ForbiddenException(body);
      if (e.status === 404) throw new NotFoundException(body);
      throw new ConflictException(body);
    }
    throw e;
  }

  /** Lojas do grupo (matriz primeiro, depois filiais por data de criação). */
  async group(eid: string) {
    const me = await this.enterprises.findById(eid).select('name parentId').lean();
    if (!me) throw new NotFoundException('Empresa não encontrada');
    const root = rootOf(me);
    const rows = await this.enterprises.find({ $or: [{ _id: new Types.ObjectId(root) }, { parentId: new Types.ObjectId(root) }] })
      .select('name parentId cnpj status createdAt staffCode').sort({ createdAt: 1 }).lean();
    rows.sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
    return { root, current: eid, stores: rows };
  }

  private async inGroup(eid: string, target: string) {
    if (!Types.ObjectId.isValid(target)) throw new NotFoundException('Loja não encontrada');
    const g = await this.group(eid);
    const t = g.stores.find((s) => String(s._id) === target);
    if (!t) throw new NotFoundException({ statusCode: 404, code: 'BRANCH_NOT_FOUND', message: 'Esta loja não é do seu grupo.' });
    return { g, t };
  }

  /** Painel "Filiais": cada loja com vendas de hoje e do mês, produtos e colaboradores. */
  async list(eid: string) {
    const g = await this.group(eid);
    const ids = g.stores.map((s) => s._id as Types.ObjectId);
    const [today, month, products, staff] = await Promise.all([
      this.sales.aggregate<{ _id: Types.ObjectId; n: number; c: number }>([{ $match: { enterpriseId: { $in: ids }, status: 'completed', createdAt: { $gte: brStart() } } }, { $group: { _id: '$enterpriseId', n: { $sum: 1 }, c: { $sum: '$totalCents' } } }]),
      this.sales.aggregate<{ _id: Types.ObjectId; n: number; c: number }>([{ $match: { enterpriseId: { $in: ids }, status: 'completed', createdAt: { $gte: monthStart() } } }, { $group: { _id: '$enterpriseId', n: { $sum: 1 }, c: { $sum: '$totalCents' } } }]),
      this.products.aggregate<{ _id: Types.ObjectId; n: number; low: number }>([{ $match: { enterpriseId: { $in: ids } } }, { $group: { _id: '$enterpriseId', n: { $sum: 1 }, low: { $sum: { $cond: [{ $and: [{ $ne: ['$trackStock', false] }, { $lte: ['$quantity', 0] }] }, 1, 0] } } } }]),
      this.staff.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { enterpriseId: { $in: ids }, active: true } }, { $group: { _id: '$enterpriseId', n: { $sum: 1 } } }]),
    ]);
    const by = <T extends { _id: Types.ObjectId }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));
    const t = by(today), m = by(month), p = by(products), s = by(staff);
    return {
      root: g.root, current: g.current, max: MAX_BRANCHES,
      stores: g.stores.map((e) => {
        const id = String(e._id);
        return {
          id, name: e.name, cnpj: e.cnpj ?? '', isRoot: !e.parentId, current: id === g.current, status: e.status, staffCode: e.staffCode ?? null,
          createdAt: (e as { createdAt?: Date }).createdAt ?? null,
          today: { count: t.get(id)?.n ?? 0, totalCents: t.get(id)?.c ?? 0 },
          month: { count: m.get(id)?.n ?? 0, totalCents: m.get(id)?.c ?? 0 },
          products: p.get(id)?.n ?? 0, outOfStock: p.get(id)?.low ?? 0, staff: s.get(id)?.n ?? 0,
        };
      }),
    };
  }

  /**
   * Cria uma filial do grupo. Herda da matriz o aceite dos termos, a isenção e o teto, mas não ganha outro período
   * grátis. O layout do sistema (cores, logo, tela de vendas) é sempre o da matriz. Não tem login próprio (senha aleatória que ninguém sabe).
   */
  async create(eid: string, dto: { name: string; cnpj?: string }) {
    try {
      const name = branchName(dto.name);
      const g = await this.group(eid);
      if (g.stores.length - 1 >= MAX_BRANCHES) throw new BranchError('BRANCH_LIMIT', `Seu grupo já tem ${MAX_BRANCHES} filiais, o máximo. Fale com o suporte para mais.`);
      if (g.stores.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())) throw new BranchError('BRANCH_NAME_USED', 'Já existe uma loja com esse nome no seu grupo.');
      const root = await this.enterprises.findById(g.root).lean();
      if (!root) throw new NotFoundException('Matriz não encontrada');
      const _id = new Types.ObjectId();
      const cnpj = String(dto.cnpj ?? '').replace(/\D/g, '').slice(0, 14);
      const created = await this.enterprises.create({
        _id, name, logo: '', email: branchEmail(String(_id)), cnpj,
        password: await bcrypt.hash(randomBytes(32).toString('hex'), 12),
        parentId: root._id,
        trialEndsAt: branchTrialEnd(trialEnd(root as never)),
        feeExempt: root.feeExempt ?? false, feeCapCents: (root as { feeCapCents?: number | null }).feeCapCents ?? null,
        termsAcceptedAt: root.termsAcceptedAt ?? null, termsVersion: root.termsVersion ?? null, privacyVersion: root.privacyVersion ?? null,
        emailVerifiedAt: new Date(),
        // Cores do painel, logo e layout do caixa não são copiados: a filial usa sempre os da matriz (layoutOwner).
      });
      this.log.log(`Filial criada: ${String(created._id)} (matriz ${g.root})`);
      return { id: String(created._id), name: created.name };
    } catch (e) {
      if (isDuplicateKeyError(e)) this.fail(new BranchError('BRANCH_NAME_USED', 'Não foi possível criar a filial. Tente de novo.'));
      this.fail(e);
    }
  }

  async rename(eid: string, target: string, raw: string) {
    try {
      const name = branchName(raw);
      const { g } = await this.inGroup(eid, target);
      if (g.stores.some((s) => String(s._id) !== target && s.name.trim().toLowerCase() === name.toLowerCase())) throw new BranchError('BRANCH_NAME_USED', 'Já existe uma loja com esse nome no seu grupo.');
      await this.enterprises.updateOne({ _id: target }, { $set: { name } });
      return { id: target, name };
    } catch (e) { this.fail(e); }
  }

  /**
   * Troca de loja do dono: sessão da loja escolhida. Numa filial, a sessão leva a matriz (`br`) e a versão da sessão
   * da matriz (`rtv`): trocar a senha ou "sair de todos" na matriz derruba também as sessões abertas nas filiais.
   */
  async switchTo(eid: string, target: string) {
    const { g, t } = await this.inGroup(eid, target);
    if (t.status === 'suspended') this.fail(new BranchError('BRANCH_SUSPENDED', 'Esta loja está suspensa. Fale com o suporte.', 403));
    const root = await this.enterprises.findById(g.root).select('+tokenVersion role').lean();
    if (!root) throw new NotFoundException('Matriz não encontrada');
    const life = webSessionLife(this.config, { admin: false });
    let payload: Record<string, unknown>;
    if (target === g.root) payload = { sub: g.root, tv: root.tokenVersion ?? 0 };
    else {
      const b = await this.enterprises.findById(target).select('+tokenVersion').lean();
      payload = { sub: target, tv: b?.tokenVersion ?? 0, br: g.root, rtv: root.tokenVersion ?? 0 };
    }
    const accessToken = this.jwt.sign(payload, { expiresIn: life as never });
    const exp = (this.jwt.decode(accessToken) as { exp?: number } | null)?.exp;
    return { accessToken, expiresAt: new Date(exp ? exp * 1000 : Date.now() + DAY), store: { id: target, name: t.name } };
  }

  /**
   * Exclui uma FILIAL do grupo (nunca a matriz), com a senha do dono. Usa a exclusão de conta de sempre: apaga
   * produtos, estoque, vendas, clientes, caixa, colaboradores, loja online e arquivos da filial; faturas e taxas ficam
   * como registro. Recusa com taxa do Balcão em aberto ou pedido online em andamento.
   */
  async remove(eid: string, target: string, password: string) {
    const { t } = await this.inGroup(eid, target);
    if (!t.parentId) this.fail(new BranchError('BRANCH_IS_ROOT', 'A matriz não é excluída por aqui. Para encerrar a empresa inteira, exclua as filiais e depois a conta da matriz em Configurações.', 400));
    try {
      await this.enterpriseService.delete(target, password);
    } catch (e) {
      // As mensagens da exclusão de conta falam em "conta": aqui é a filial.
      const code = (e as { response?: { code?: string } }).response?.code;
      if (code === 'DEBT_OPEN') this.fail(new BranchError('DEBT_OPEN', `A filial ${t.name} tem taxa do Balcão em aberto. Pague a fatura dela (entre na filial, em Plano e pagamento) antes de excluir.`));
      if (code === 'ORDERS_OPEN') this.fail(new BranchError('ORDERS_OPEN', `A loja online da filial ${t.name} tem pedido em andamento. Entregue, cancele ou devolva antes de excluir: o comprador não pode ficar sem resposta.`));
      if (e instanceof ForbiddenException && /senha/i.test(e.message)) this.fail(new BranchError('OWNER_PASSWORD_WRONG', 'Senha do dono incorreta.', 403));
      throw e;
    }
    this.log.log(`Filial excluída: ${target} (grupo de ${String(t.parentId)})`);
    return { id: target, name: t.name, rootId: String(t.parentId) };
  }

  /** Busca de produto em todas as lojas do grupo: preço e estoque de cada uma. */
  async searchProducts(eid: string, q: string) {
    const term = q.trim().slice(0, 60);
    if (term.length < 2) return { items: [] };
    const g = await this.group(eid);
    const names = new Map(g.stores.map((s) => [String(s._id), { name: s.name, isRoot: !s.parentId }]));
    const rx = { $regex: escapeRegex(term), $options: 'i' };
    const rows = await this.products.find({ enterpriseId: { $in: g.stores.map((s) => s._id) }, $or: [{ name: rx }, { code: rx }] })
      .select('enterpriseId name code price priceWithDiscount quantity trackStock image').sort({ name: 1 }).limit(120).lean();
    // Agrupa o "mesmo produto" pelo código (é assim que a importação casa os produtos entre lojas).
    const byCode = new Map<string, { code: string; name: string; image: string; stores: { storeId: string; storeName: string; productId: string; priceCents: number; quantity: number | null; current: boolean }[] }>();
    for (const r of rows) {
      const key = r.code.trim().toLowerCase();
      const item = byCode.get(key) ?? { code: r.code, name: r.name, image: r.image ?? '', stores: [] };
      const sid = String(r.enterpriseId);
      item.stores.push({ storeId: sid, storeName: names.get(sid)?.name ?? '', productId: String(r._id), priceCents: Math.round((r.priceWithDiscount || r.price) * 100), quantity: r.trackStock === false ? null : r.quantity, current: sid === eid });
      if (!item.image && r.image) item.image = r.image;
      byCode.set(key, item);
    }
    return { items: [...byCode.values()].slice(0, 40) };
  }

  /** Produtos de outra loja do grupo, para escolher o que importar. */
  async sourceProducts(eid: string, from: string, q: string, page: number) {
    if (from === eid) this.fail(new BranchError('IMPORT_SAME_STORE', 'Escolha outra loja: esta é a loja em que você está.', 400));
    await this.inGroup(eid, from);
    const term = q.trim().slice(0, 60);
    const filter: Record<string, unknown> = { enterpriseId: new Types.ObjectId(from) };
    if (term) { const rx = { $regex: escapeRegex(term), $options: 'i' }; filter.$or = [{ name: rx }, { code: rx }]; }
    const limit = 50;
    const [rows, total, mine] = await Promise.all([
      this.products.find(filter).select('name code price priceWithDiscount quantity trackStock image categoryId').sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.products.countDocuments(filter),
      this.products.find({ enterpriseId: new Types.ObjectId(eid) }).select('code').lean(),
    ]);
    const have = new Set(mine.map((p) => p.code.trim().toLowerCase()));
    return {
      total, page, limit,
      items: rows.map((r) => ({ id: String(r._id), name: r.name, code: r.code, image: r.image ?? '', priceCents: Math.round((r.priceWithDiscount || r.price) * 100), quantity: r.trackStock === false ? null : r.quantity, exists: have.has(r.code.trim().toLowerCase()) })),
    };
  }

  /**
   * Importa produtos de outra loja do grupo PARA a loja da sessão: nome, código, preços e desconto, descrição,
   * categoria (criada pelo nome se faltar), opções, dados da loja online e fotos (copiadas para a pasta desta loja,
   * para nunca depender da outra). Estoque começa em zero, salvo `withStock`. Códigos que já existem aqui são pulados.
   */
  async importProducts(eid: string, dto: { from: string; productIds?: string[]; all?: boolean; withStock?: boolean }) {
    if (dto.from === eid) this.fail(new BranchError('IMPORT_SAME_STORE', 'Escolha outra loja: esta é a loja em que você está.', 400));
    await this.inGroup(eid, dto.from);
    const ids = (dto.productIds ?? []).filter((x) => Types.ObjectId.isValid(x));
    if (!dto.all && !ids.length) this.fail(new BranchError('IMPORT_EMPTY', 'Escolha os produtos para importar.', 400));
    const from = new Types.ObjectId(dto.from), to = new Types.ObjectId(eid);
    const source = await this.products.find({ enterpriseId: from, ...(dto.all ? {} : { _id: { $in: ids.map((x) => new Types.ObjectId(x)) } }) }).limit(5000).lean();
    const [srcCats, myCats, myCodes] = await Promise.all([
      this.categories.find({ enterpriseId: from }).select('name').lean(),
      this.categories.find({ enterpriseId: to }).select('name').lean(),
      this.products.find({ enterpriseId: to }).select('code').lean(),
    ]);
    const srcCatName = new Map(srcCats.map((c) => [String(c._id), c.name]));
    const plan = importPlan(source.map((p) => ({ _id: p._id, code: p.code, name: p.name, categoryName: srcCatName.get(String(p.categoryId)) ?? 'Geral' })), myCodes.map((p) => p.code), myCats.map((c) => c.name));
    // Categorias que faltam (pelo nome; se outra aba criou ao mesmo tempo, usa a que já existe).
    for (const name of plan.newCategories) {
      try { await this.categories.create({ name, enterpriseId: to }); } catch (e) { if (!isDuplicateKeyError(e)) throw e; }
    }
    const catByName = new Map((await this.categories.find({ enterpriseId: to }).select('name').lean()).map((c) => [c.name.trim().toLowerCase(), c._id]));
    const byId = new Map(source.map((p) => [String(p._id), p]));
    let imported = 0, photosCopied = 0, photosFailed = 0;
    const skipped = [...plan.skipped];
    for (const item of plan.take) {
      const p = byId.get(String(item._id))!;
      // Fotos: copia o arquivo para a pasta desta loja (a original pode ser apagada lá sem afetar aqui).
      const images: string[] = [];
      for (const url of (p.images?.length ? p.images : p.image ? [p.image] : []).slice(0, 8)) {
        if (!this.storage.isOurs(url)) { if (/^https:\/\//.test(url)) images.push(url); continue; }
        try {
          const data = await this.storage.readOwn(url);
          if (!data) { photosFailed++; continue; }
          images.push((await this.storage.ingest(eid, 'product', data)).url); photosCopied++;
        } catch (e) {
          photosFailed++;
          if (e instanceof HttpException && /cota|espaço|limite/i.test(String((e.getResponse() as { message?: string })?.message ?? ''))) break;
        }
      }
      const trackStock = p.trackStock !== false;
      try {
        await this.products.create({
          enterpriseId: to, categoryId: catByName.get(item.categoryName.trim().toLowerCase()),
          name: p.name, code: p.code, description: p.description ?? '',
          price: p.price, priceWithDiscount: p.priceWithDiscount, discountPercentage: p.discountPercentage ?? 0, discountMode: p.discountMode ?? 'percent',
          trackStock, quantity: trackStock && dto.withStock ? Math.max(0, p.quantity ?? 0) : 0,
          images, image: images[0] ?? '',
          onlinePrice: p.onlinePrice ?? null, showOnline: p.showOnline ?? false,
          weightGrams: p.weightGrams ?? null, heightCm: p.heightCm ?? null, widthCm: p.widthCm ?? null, lengthCm: p.lengthCm ?? null,
          options: p.options ?? [],
        });
        imported++;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        skipped.push({ code: p.code, name: p.name });
        if (images.length) await this.storage.release(eid, images);
      }
    }
    this.log.log(`Importação ${dto.from} → ${eid}: ${imported} produto(s), ${skipped.length} pulado(s), ${photosCopied} foto(s) copiada(s), ${photosFailed} falha(s) de foto`);
    return { imported, skipped, categoriesCreated: plan.newCategories.length, photosCopied, photosFailed };
  }
}
