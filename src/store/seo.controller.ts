import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ProductService } from '../products/product.service';
import { StoreService } from './store.service';

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const day = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);
const urlTag = (loc: string, lastmod?: string, priority?: string) =>
  `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}${priority ? `<priority>${priority}</priority>` : ''}</url>`;
/** Páginas públicas do Balcão (o resto, /app, /conta, checkout e pedidos, fica fora e é bloqueado no robots.txt). */
const PLATFORM_PAGES: [string, string][] = [['/', '1.0'], ['/lojas', '0.9'], ['/registrar', '0.6'], ['/termos', '0.3'], ['/privacidade', '0.3'], ['/reembolso', '0.3'], ['/cookies', '0.2']];

/**
 * SEO da plataforma e das lojas: sitemaps (o robots.txt do site aponta para o índice daqui), manifest e ícone de cada loja.
 * Tudo público e sem dados internos; lojas desligadas ou suspensas não aparecem.
 */
@Public()
@SkipThrottle()
@Controller('public')
export class SeoController {
  constructor(private readonly stores: StoreService, private readonly products: ProductService, private readonly config: ConfigService) {}

  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, ''); }
  private get api() { return (this.config.get<string>('APP_URL') ?? 'http://localhost:2700').replace(/\/$/, ''); }

  private xml(res: Response, body: string) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
  }

  /** Índice: o sitemap do Balcão e um de cada loja no ar. */
  @Get('sitemap.xml')
  async index(@Res() res: Response) {
    const list = await this.stores.sitemapStores();
    const items = [`<sitemap><loc>${esc(`${this.api}/public/sitemap-balcao.xml`)}</loc></sitemap>`, ...list.map((s) => `<sitemap><loc>${esc(`${this.api}/public/store/${s.slug}/sitemap.xml`)}</loc>${s.updatedAt ? `<lastmod>${day(s.updatedAt)}</lastmod>` : ''}</sitemap>`)];
    this.xml(res, `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items.join('')}</sitemapindex>`);
  }

  @Get('sitemap-balcao.xml')
  platform(@Res() res: Response) {
    this.xml(res, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PLATFORM_PAGES.map(([p, pr]) => urlTag(`${this.front}${p === '/' ? '' : p}`, undefined, pr)).join('')}</urlset>`);
  }

  /** Sitemap da loja: página inicial, políticas e cada produto publicado (com a data da última mudança). */
  @Get('store/:slug/sitemap.xml')
  async store(@Param('slug') slug: string, @Res() res: Response) {
    const { store } = await this.stores.publicBySlug(slug);
    const base = `${this.front}/loja/${store.slug}`;
    const items = await this.products.sitemapEntries(String(store.enterpriseId));
    const urls = [urlTag(base, day((store as unknown as { updatedAt?: Date }).updatedAt), '1.0'), urlTag(`${base}/politicas`, undefined, '0.2'), ...items.map((p) => urlTag(`${base}/p/${p.id}`, day(p.updatedAt), '0.8'))];
    this.xml(res, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  }

  /** Manifest da loja: "Adicionar à tela inicial" abre direto a loja, com o nome e a cor dela. */
  @Get('store/:slug/manifest.webmanifest')
  async manifest(@Param('slug') slug: string, @Res() res: Response) {
    const { store, enterprise } = await this.stores.publicBySlug(slug);
    const dark = store.theme?.background === 'dark' || (store.theme?.background === 'custom' && /^#[0-3]/.test(store.theme?.bgColor ?? ''));
    const hasIcon = !!(store.seo?.favicon || store.logo || enterprise.logo);
    const title = store.seo?.title || store.name;
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(JSON.stringify({
      name: title.slice(0, 70), short_name: store.name.slice(0, 24), description: (store.seo?.description || store.tagline || '').slice(0, 160),
      start_url: `${this.front}/loja/${store.slug}`, scope: `${this.front}/loja/${store.slug}`, display: 'standalone', lang: 'pt-BR',
      theme_color: store.theme?.accent ?? '#FF3D00', background_color: store.theme?.background === 'custom' ? store.theme.bgColor : dark ? '#111111' : '#ffffff',
      icons: hasIcon ? [{ src: `${this.api}/public/store/${store.slug}/icon`, sizes: 'any', purpose: 'any' }] : [],
    }));
  }

  /** Favicon da loja (ou o logo, se não houver favicon), como arquivo de imagem. */
  @Get('store/:slug/icon')
  async icon(@Param('slug') slug: string, @Res() res: Response) {
    const { store, enterprise } = await this.stores.publicBySlug(slug);
    const src = store.seo?.favicon || store.logo || enterprise.logo || '';
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (/^https?:\/\//.test(src)) return res.redirect(302, src); // arquivo no R2 (ou pasta local em desenvolvimento)
    const m = /^data:(image\/(?:png|jpeg|webp|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (!m) throw new NotFoundException('Ícone não encontrado');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(Buffer.from(m[2], 'base64'));
  }
}
