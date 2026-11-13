import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { DomainService } from './domain.service';
import { MpOrdersWebhookService } from './mp-orders-webhook.service';
import type { Request, Response } from 'express';
import { ShopperService } from '../shopper/shopper.service';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { StoreService } from './store.service';
import { MarketplaceService } from './marketplace.service';
import { RewardsService } from './rewards.service';
import { MediaService } from './media.service';
import { EmailCodeService } from './email-code.service';
import { ProtectionService } from './protection.service';
import { OrderService } from './order.service';
import { CheckoutDto, PublicDisputeDto, EmailCodeDto, EmailVerifyDto, DirectoryQueryDto, CouponCheckDto, MarketProductsQueryDto, VisitorQueryDto, OrderAccessDto, OrderConfirmDto, PublicProductsQueryDto, QuoteDto } from './dto/order.dto';
import { ProductService } from '../products/product.service';
import { PromotionService } from '../promotion/promotion.service';
import { toCents } from '../common/money';
import { onlineEffectivePrice } from '../products/schema/product.schema';
import { minExtraCents, type OptionGroup } from '../products/options.rules';

export type P = Awaited<ReturnType<ProductService['publicGet']>> & { promotion?: { priceCents: number; remaining: number | null; endsAt: Date | null; name: string } | null };

/** Produto como a vitrine vê: preço em centavos, promoção e disponibilidade (sem saldo exato, a menos que a loja mostre). */
export function card(p: P, showStock: boolean, store?: { slug: string; name: string; cashbackBps?: number }) {
  const normal = toCents(onlineEffectivePrice(p)); // preço da loja online
  const promo = p.promotion && p.promotion.priceCents < normal ? p.promotion : null;
  const left = p.trackStock === false ? null : p.quantity;
  return {
    id: String(p._id), name: p.name, description: p.description ?? '', image: p.image ?? '', categoryId: String(p.categoryId),
    priceCents: promo ? promo.priceCents : normal,
    compareAtCents: promo ? Math.max(normal, toCents(p.price)) : toCents(p.price) > normal ? toCents(p.price) : null,
    promo: promo ? { name: promo.name, remaining: promo.remaining, endsAt: promo.endsAt } : null,
    inStock: left === null || left > 0,
    stockLeft: showStock && left !== null ? left : left !== null && left > 0 && left <= 3 ? left : null, // "últimas unidades" sempre aparece
    // Quantas fotos o produto tem (a segunda aparece ao passar o mouse, pela rota /image?i=1).
    photos: (p as unknown as { _photos?: number })._photos ?? p.images?.length ?? (p.image ? 1 : 0),
    // Prova social real: média das avaliações dos compradores e unidades já vendidas.
    rating: { avg: (p as unknown as { ratingAvg?: number }).ratingAvg ?? 0, count: (p as unknown as { ratingCount?: number }).ratingCount ?? 0 },
    sold: (p as unknown as { soldCount?: number }).soldCount ?? 0,
    // Adicionais do cardápio (a vitrine abre a escolha antes de pôr no carrinho). Preço sempre reconferido no checkout.
    options: (p as unknown as { options?: OptionGroup[] }).options ?? [],
    fromCents: (promo ? promo.priceCents : normal) + minExtraCents((p as unknown as { options?: OptionGroup[] }).options),
    ...(store ? { store } : {}),
  };
}

@Public()
@Controller('public')
export class StorefrontController {
  constructor(
    private readonly stores: StoreService,
    private readonly orders: OrderService,
    private readonly products: ProductService,
    private readonly promotions: PromotionService,
    private readonly shoppers: ShopperService,
    private readonly media: MediaService,
    private readonly emailCodes: EmailCodeService,
    private readonly market: MarketplaceService,
    private readonly rewards: RewardsService,
    private readonly protection: ProtectionService,
    private readonly ordersHook: MpOrdersWebhookService,
    private readonly domainsSvc: DomainService,
  ) {}

  /** Vitrine aberta num domínio próprio: qual loja é (o site chama ao abrir num endereço que não é o da plataforma). */
  @Get('store-by-host')
  storeByHost(@Query('host') host?: string) { return this.domainsSvc.byHost(String(host ?? '').slice(0, 253)); }

  /**
   * O Caddy pergunta antes de emitir o certificado HTTPS de um domínio (on_demand_tls ask): 200 = pode, 404 = não.
   * Só domínios ativos de alguma loja; sem isso, qualquer um apontaria um domínio e gastaria os certificados.
   */
  @SkipThrottle()
  @Get('domains/allow')
  async domainAllow(@Query('domain') domain?: string) {
    if (!(await this.domainsSvc.allow(String(domain ?? '').slice(0, 253)))) throw new NotFoundException('Domínio não liberado');
    return { ok: true };
  }

  /** Página "Lojas no Balcão". */
  @Get('stores')
  directory(@Query() q: DirectoryQueryDto) {
    return this.stores.directory({ ...q, limit: Math.min(q.limit, 48) });
  }

  /** Produtos de todas as lojas listadas (marketplace): busca, segmento da loja, ordem e só ofertas. */
  @Get('products')
  async allProducts(@Query() q: MarketProductsQueryDto) {
    let listed = await this.stores.listedStores();
    if (q.segment) listed = listed.filter((s) => s.segment === q.segment);
    if (!listed.length) return { items: [], total: 0, page: q.page, limit: q.limit };
    // Ofertas: também os produtos em promoção ativa (é delas que sai a contagem regressiva do marketplace).
    const promoIds = q.offers ? (await Promise.all(listed.map((s) => this.promotions.activeProductIds(s.enterpriseId)))).flat() : undefined;
    const page = await this.products.publicList(listed.map((s) => s.enterpriseId), { search: q.search, page: q.page, limit: Math.min(q.limit, 48), inStock: true, sort: q.sort, offers: q.offers, lowStock: q.lowStock, promoIds });
    return { ...page, items: await this.marketCards(page.items as P[], listed) };
  }

  /** Vídeos das lojas ("vídeos que vendem"), intercalando lojas, cada um com o cartão do produto. */
  @Get('reels')
  async marketReels() {
    const stores = await this.stores.listedReels();
    const out: { video: string; title: string; store: { slug: string; name: string; logo: string; accent: string }; product: ReturnType<typeof card> }[][] = [];
    for (const s of stores) {
      const found = await this.promotions.decorate(s.enterpriseId, await this.products.publicMany(s.enterpriseId, s.reels.map((r) => r.productId)));
      const byId = new Map(found.map((p) => [String((p as P)._id), card(p as P, false, { slug: s.slug, name: s.name, cashbackBps: s.cashbackBps })]));
      out.push(s.reels.filter((r) => byId.has(r.productId)).map((r) => ({ video: r.video, title: r.title ?? '', store: { slug: s.slug, name: s.name, logo: s.logo, accent: s.accent }, product: byId.get(r.productId)! })));
    }
    // Um de cada loja por vez, para a faixa não ficar com uma loja só.
    const items: (typeof out)[number] = [];
    for (let i = 0; items.length < 16 && out.some((l) => l[i]); i++) for (const l of out) if (l[i] && items.length < 16) items.push(l[i]);
    return { items };
  }

  /** Acontecendo agora: vendas recentes (sem dados pessoais), produtos novos e cupons perto de acabar. */
  @Get('activity')
  async activity() {
    const listed = await this.stores.listedStores();
    const byE = new Map(listed.map((s) => [s.enterpriseId, s]));
    const eids = listed.map((s) => s.enterpriseId);
    const [sales, fresh, coupons] = await Promise.all([
      this.market.recentSales(eids),
      this.products.recentPublic(eids, new Date(Date.now() - 7 * 864e5)),
      this.rewards.publicCoupons(eids, 24),
    ]);
    const store = (eid: string) => { const s = byE.get(eid)!; return { slug: s.slug, name: s.name }; };
    const img = (eid: string, pid: string) => `/public/store/${encodeURIComponent(byE.get(eid)!.slug)}/products/${pid}/image`;
    const items = [
      ...sales.map((x) => ({ kind: 'sale' as const, at: x.at, text: x.productName, city: x.city, productId: x.productId, image: img(x.enterpriseId, x.productId), store: store(x.enterpriseId) })),
      ...fresh.map((p) => ({ kind: 'new' as const, at: (p as unknown as { createdAt: Date }).createdAt, text: p.name, city: '', productId: String(p._id), image: img(String(p.enterpriseId), String(p._id)), store: store(String(p.enterpriseId)) })),
      ...coupons.filter((c) => c.endsAt && new Date(c.endsAt).getTime() - Date.now() < 48 * 3600_000).map((c) => ({ kind: 'coupon' as const, at: c.endsAt, text: `${c.code} · ${c.label}`, city: '', productId: '', image: '', store: store(c.enterpriseId) })),
    ];
    return { items: items.sort((a, b) => new Date(b.at as Date).getTime() - new Date(a.at as Date).getTime()).slice(0, 14) };
  }

  /** Cupons públicos de todas as lojas do marketplace (os que acabam antes primeiro). */
  @Get('coupons')
  async marketCoupons() {
    const listed = await this.stores.listedStores();
    const byE = new Map(listed.map((s) => [s.enterpriseId, s]));
    const rows = await this.rewards.publicCoupons(listed.map((s) => s.enterpriseId), 24);
    return { items: rows.map(({ enterpriseId, ...c }) => { const s = byE.get(enterpriseId)!; return { ...c, store: { slug: s.slug, name: s.name, logo: s.logo, accent: s.accent } }; }) };
  }

  /** Cupons públicos de uma loja (vitrine e checkout). */
  @Get('store/:slug/coupons')
  async storeCoupons(@Param('slug') slug: string) {
    const { store } = await this.stores.publicBySlug(slug);
    return { items: (await this.rewards.publicCoupons([String(store.enterpriseId)], 12)).map(({ enterpriseId: _e, ...c }) => c) };
  }

  /** Confere o cupom para o carrinho (prévia; o desconto de verdade é calculado de novo no pedido). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('store/:slug/coupon-check') @HttpCode(200)
  async couponCheck(@Param('slug') slug: string, @Body() dto: CouponCheckDto) {
    const { store } = await this.stores.publicBySlug(slug, { forOrder: true });
    const lines = await this.orders.priceCart(store, dto.items);
    const subtotal = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
    return this.rewards.check(String(store.enterpriseId), dto.code, subtotal, dto.email);
  }

  /** Saldo de cashback do comprador logado nesta loja. */
  @Get('store/:slug/credit')
  async credit(@Param('slug') slug: string, @Req() req: Request) {
    const { store } = await this.stores.publicBySlug(slug);
    const shopper = await this.shoppers.fromRequest(req);
    const cb = await this.rewards.cashbackOf(String(store.enterpriseId));
    return { logged: !!shopper, balanceCents: shopper ? await this.rewards.balance(shopper._id, String(store.enterpriseId)) : 0, cashback: cb };
  }

  /** Saldos de cashback do comprador em todas as lojas (conta do comprador). */
  @Get('my-credits')
  async myCredits(@Req() req: Request) {
    const shopper = await this.shoppers.fromRequest(req);
    return { items: shopper ? await this.rewards.balances(shopper._id) : [] };
  }

  /** Recomendados para o visitante (ou em alta, sem histórico). */
  @Get('recommendations')
  async recommendations(@Query() q: VisitorQueryDto) {
    const { ids, personal } = await this.market.recommend(q.visitorId, q.limit ?? 12);
    return { personal, items: await this.marketCards((await this.products.publicByIds(ids)) as unknown as P[], await this.stores.listedStores()) };
  }

  /** Produtos curtidos pelo visitante, mais recentes primeiro. */
  @Get('likes')
  async likes(@Query() q: VisitorQueryDto) {
    if (!q.visitorId) return { ids: [], items: [] };
    const ids = await this.market.likedIds(q.visitorId);
    return { ids, items: await this.marketCards((await this.products.publicByIds(ids.slice(0, 48))) as unknown as P[], await this.stores.listedStores()) };
  }

  /** Cartões com a loja de cada produto; produtos de lojas fora do marketplace saem. */
  private async marketCards(list: P[], listed: { enterpriseId: string; slug: string; name: string; cashbackBps?: number }[]) {
    const byEid = new Map(listed.map((s) => [s.enterpriseId, s]));
    const items: ReturnType<typeof card>[] = [];
    for (const p of list) {
      const s = byEid.get(String((p as unknown as { enterpriseId: unknown }).enterpriseId));
      if (!s) continue;
      const [d] = await this.promotions.decorate(s.enterpriseId, [p]);
      items.push(card(d as P, false, { slug: s.slug, name: s.name, cashbackBps: s.cashbackBps ?? 0 }));
    }
    return items;
  }

  @Get('store/:slug')
  async info(@Param('slug') slug: string, @Query('preview') preview?: string) {
    const info = await this.stores.publicInfo(slug, preview?.slice(0, 200));
    if (!info.reels.length) return { ...info, reels: [] };
    // "Vídeos que vendem": junta o produto (preço, foto, estoque) a cada vídeo; some se o produto saiu da loja.
    const { store } = await this.stores.publicBySlug(slug, { preview: preview?.slice(0, 200) });
    const eid = String(store.enterpriseId);
    const found = await this.promotions.decorate(eid, await this.products.publicMany(eid, info.reels.map((r) => r.productId)));
    const byId = new Map(found.map((p) => [String((p as P)._id), card(p as P, false)]));
    return { ...info, reels: info.reels.filter((r) => byId.has(r.productId)).map((r) => ({ video: r.video, title: r.title, product: byId.get(r.productId)! })) };
  }

  @Get('store/:slug/products')
  async list(@Param('slug') slug: string, @Query() q: PublicProductsQueryDto) {
    const { store } = await this.stores.publicBySlug(slug, { preview: q.preview });
    const eid = String(store.enterpriseId);
    const promoIds = q.offers ? await this.promotions.activeProductIds(eid) : undefined;
    const ids = q.ids ? q.ids.split(',') : undefined;
    const page = await this.products.publicList([eid], { search: q.search, categoryId: q.categoryId, ids, page: q.page, limit: Math.min(q.limit, 48), sort: q.sort, offers: q.offers, promoIds });
    // Produtos escolhidos: mantém a ordem que o lojista montou.
    if (ids) page.items.sort((a, b) => ids.indexOf(String((a as { _id: unknown })._id)) - ids.indexOf(String((b as { _id: unknown })._id)));
    const items = await this.promotions.decorate(eid, page.items);
    return { ...page, items: items.map((p) => card(p as P, !!store.theme?.showStock)) };
  }

  @Get('store/:slug/products/:id')
  async product(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Query('preview') preview?: string) {
    const { store } = await this.stores.publicBySlug(slug, { preview: preview?.slice(0, 200) });
    const eid = String(store.enterpriseId);
    const [p] = await this.promotions.decorate(eid, [await this.products.publicGet(eid, id)]);
    return { ...card(p as P, !!store.theme?.showStock), images: (p as P & { images?: string[] }).images ?? [] };
  }

  /**
   * Foto do produto como arquivo (com cache do navegador), em vez de texto base64 dentro do JSON.
   * `?i=` escolhe a foto (0 = capa).
   */
  @SkipThrottle()
  @Get('store/:slug/products/:id/image')
  async image(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Query('i') i: string | undefined, @Res() res: Response, @Query('preview') preview?: string) {
    const { store } = await this.stores.publicBySlug(slug, { preview: preview?.slice(0, 200) });
    const p = await this.products.publicGet(String(store.enterpriseId), id);
    const k = Math.max(0, Math.min(7, Number.parseInt(i ?? '0', 10) || 0));
    const src = (p.images ?? [])[k];
    if (!src) throw new NotFoundException('Foto não encontrada');
    // Sem isto o helmet manda Cross-Origin-Resource-Policy: same-origin e o navegador bloqueia a foto na loja.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (/^https?:\/\//.test(src)) return res.redirect(302, src); // arquivo no R2 (ou pasta local em desenvolvimento)
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (!m) throw new NotFoundException('Foto não encontrada');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // a loja (outro domínio) pode exibir
    res.send(Buffer.from(m[2], 'base64'));
  }

  /** Vídeo da vitrine, com suporte a trechos (Range) para o player pular e começar rápido. */
  @SkipThrottle()
  @Get('media/:id')
  async mediaFile(@Param('id', ParseMongoIdPipe) id: string, @Headers('range') range: string | undefined, @Res() res: Response) {
    const m = await this.media.open(id, range);
    if (m.status === 302) { res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); return res.redirect(301, m.location); } // já está no R2
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', m.type);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (m.status === 416) { res.setHeader('Content-Range', `bytes */${m.size}`); return res.status(416).end(); }
    res.status(m.status);
    res.setHeader('Content-Length', String(m.end - m.start + 1));
    if (m.status === 206) res.setHeader('Content-Range', `bytes ${m.start}-${m.end}/${m.size}`);
    m.stream.on('error', () => res.destroy()).pipe(res);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('store/:slug/quote')
  @HttpCode(200)
  quote(@Param('slug') slug: string, @Body() dto: QuoteDto, @Query('preview') preview?: string) {
    return this.orders.quote(slug, dto.cep, dto.items, preview?.slice(0, 200));
  }

  /** Compra sem conta: manda um código de 6 números para o e-mail. */
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  @Post('store/:slug/email-code') @HttpCode(200)
  async emailCode(@Param('slug') slug: string, @Body() dto: EmailCodeDto, @Query('preview') preview?: string) {
    const { store } = await this.stores.publicBySlug(slug, { preview: preview?.slice(0, 200) });
    return this.emailCodes.send(dto.email, store.name);
  }

  @Throttle({ default: { limit: 10, ttl: 10 * 60_000 } })
  @Post('store/:slug/email-code/verify') @HttpCode(200)
  emailVerify(@Body() dto: EmailVerifyDto) { return this.emailCodes.verify(dto.email, dto.code); }

  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('store/:slug/orders')
  async checkout(@Param('slug') slug: string, @Body() dto: CheckoutDto, @Req() req: Request) {
    return this.orders.checkout(slug, dto, await this.shoppers.fromRequest(req), req.ip ?? '');
  }

  @Get('store/:slug/orders/:id')
  order(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Query() q: OrderAccessDto) {
    return this.orders.publicView(slug, id, q.t);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('store/:slug/orders/:id/confirm')
  @HttpCode(200)
  confirm(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: OrderConfirmDto) {
    return this.orders.confirmFromRedirect(slug, id, dto);
  }

  /** Compra protegida: o comprador confirma que recebeu (com o link do pedido). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('store/:slug/orders/:id/received') @HttpCode(200)
  async received(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: OrderAccessDto) {
    return this.protection.received(await this.orders.byToken(slug, id, dto.t), 'cliente');
  }

  /** Compra protegida: não recebi, defeito, diferente do anunciado ou desistência (7 dias). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('store/:slug/orders/:id/dispute') @HttpCode(200)
  async dispute(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: PublicDisputeDto) {
    return this.protection.openDispute(await this.orders.byToken(slug, id, dto.t), dto.reason, dto.message);
  }

  /**
   * Webhook único das ordens de Checkout Pro (API de Orders): é o endereço cadastrado no painel da aplicação, evento
   * "Order". Vale para faturas do Balcão, pedidos da loja e comandas (ver mp-orders-webhook.service.ts).
   */
  @SkipThrottle()
  @Post('mercadopago/webhook')
  @HttpCode(200)
  ordersWebhook(@Query() q: Record<string, unknown>, @Body() body: Record<string, unknown> | undefined, @Headers('x-signature') signature?: string, @Headers('x-request-id') requestId?: string) {
    return this.ordersHook.handle(q, (body ?? {}) as Record<string, any>, { signature, requestId });
  }

  /** Webhook do Mercado Pago para pedidos da loja online (token por pedido na URL + consulta do pagamento). */
  @SkipThrottle()
  @Post('store-webhook/mercadopago')
  @HttpCode(200)
  webhook(@Query() q: Record<string, unknown>, @Body() body: Record<string, unknown> | undefined, @Headers('x-signature') signature?: string, @Headers('x-request-id') requestId?: string) {
    return this.orders.webhook(q, body ?? {}, { signature, requestId });
  }
}
