import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { StoreService } from './store.service';
import { OrderService } from './order.service';
import { CheckoutDto, DirectoryQueryDto, OrderAccessDto, OrderConfirmDto, PublicProductsQueryDto, QuoteDto } from './dto/order.dto';
import { ProductService } from '../products/product.service';
import { PromotionService } from '../promotion/promotion.service';
import { toCents } from '../common/money';
import { effectivePrice } from '../products/schema/product.schema';

type P = Awaited<ReturnType<ProductService['publicGet']>> & { promotion?: { priceCents: number; remaining: number | null; endsAt: Date | null; name: string } | null };

/** Produto como a vitrine vê: preço em centavos, promoção e disponibilidade (sem saldo exato, a menos que a loja mostre). */
function card(p: P, showStock: boolean, store?: { slug: string; name: string }) {
  const normal = toCents(effectivePrice(p));
  const promo = p.promotion && p.promotion.priceCents < normal ? p.promotion : null;
  const left = p.trackStock === false ? null : p.quantity;
  return {
    id: String(p._id), name: p.name, description: p.description ?? '', image: p.image ?? '', categoryId: String(p.categoryId),
    priceCents: promo ? promo.priceCents : normal,
    compareAtCents: promo ? Math.max(normal, toCents(p.price)) : toCents(p.price) > normal ? toCents(p.price) : null,
    promo: promo ? { name: promo.name, remaining: promo.remaining, endsAt: promo.endsAt } : null,
    inStock: left === null || left > 0,
    stockLeft: showStock && left !== null ? left : left !== null && left > 0 && left <= 3 ? left : null, // "últimas unidades" sempre aparece
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
  ) {}

  /** Página "Lojas no Balcão". */
  @Get('stores')
  directory(@Query() q: DirectoryQueryDto) {
    return this.stores.directory({ ...q, limit: Math.min(q.limit, 48) });
  }

  /** Busca de produtos em todas as lojas listadas. */
  @Get('products')
  async allProducts(@Query() q: PublicProductsQueryDto) {
    const listed = await this.stores.listedStores();
    if (!listed.length) return { items: [], total: 0, page: q.page, limit: q.limit };
    const page = await this.products.publicList(listed.map((s) => s.enterpriseId), { search: q.search, page: q.page, limit: Math.min(q.limit, 48), inStock: true });
    const byEid = new Map(listed.map((s) => [s.enterpriseId, s]));
    const items: ReturnType<typeof card>[] = [];
    for (const p of page.items) {
      const s = byEid.get(String(p.enterpriseId))!;
      const [d] = await this.promotions.decorate(s.enterpriseId, [p]);
      items.push(card(d as P, false, { slug: s.slug, name: s.name }));
    }
    return { ...page, items };
  }

  @Get('store/:slug')
  info(@Param('slug') slug: string) {
    return this.stores.publicInfo(slug);
  }

  @Get('store/:slug/products')
  async list(@Param('slug') slug: string, @Query() q: PublicProductsQueryDto) {
    const { store } = await this.stores.publicBySlug(slug);
    const eid = String(store.enterpriseId);
    const page = await this.products.publicList([eid], { search: q.search, categoryId: q.categoryId, page: q.page, limit: Math.min(q.limit, 48) });
    const items = await this.promotions.decorate(eid, page.items);
    return { ...page, items: items.map((p) => card(p as P, !!store.theme?.showStock)) };
  }

  @Get('store/:slug/products/:id')
  async product(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string) {
    const { store } = await this.stores.publicBySlug(slug);
    const eid = String(store.enterpriseId);
    const [p] = await this.promotions.decorate(eid, [await this.products.publicGet(eid, id)]);
    return card(p as P, !!store.theme?.showStock);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('store/:slug/quote')
  @HttpCode(200)
  quote(@Param('slug') slug: string, @Body() dto: QuoteDto) {
    return this.orders.quote(slug, dto.cep, dto.items);
  }

  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('store/:slug/orders')
  checkout(@Param('slug') slug: string, @Body() dto: CheckoutDto) {
    return this.orders.checkout(slug, dto);
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

  /** Webhook do Mercado Pago para pedidos da loja online (token por pedido na URL + consulta do pagamento). */
  @SkipThrottle()
  @Post('store-webhook/mercadopago')
  @HttpCode(200)
  webhook(@Query() q: Record<string, unknown>, @Body() body: Record<string, unknown> | undefined, @Headers('x-signature') signature?: string, @Headers('x-request-id') requestId?: string) {
    return this.orders.webhook(q, body ?? {}, { signature, requestId });
  }
}
