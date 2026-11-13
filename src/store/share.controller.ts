import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import sharp from 'sharp';
import { Public } from '../common/decorators/public.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { ProductService } from '../products/product.service';
import { PromotionService } from '../promotion/promotion.service';
import { StorageService } from '../storage/storage.service';
import { DomainService } from './domain.service';
import { storeUrl } from './domain.rules';
import { parseSharePath, productMeta, renderShareHtml, storeMeta, type ShareMeta, type ShareStore } from './share.rules';
import { card, type P } from './storefront.controller';
import { StoreService } from './store.service';

const W = 1200; const H = 630;

/**
 * Link mágico: o Caddy manda para cá só os leitores de prévia (WhatsApp, Facebook, X, LinkedIn, Telegram…) que abrem um
 * link de loja ou de produto. Devolve uma página com título, preço, descrição e foto daquele produto (ou da loja), e a
 * foto em JPEG 1200×630, que todos esses leitores aceitam (as fotos da loja ficam em WebP).
 */
@Public()
@Controller('public')
export class ShareController {
  constructor(
    private readonly stores: StoreService,
    private readonly products: ProductService,
    private readonly promotions: PromotionService,
    private readonly domains: DomainService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, ''); }
  private get api() { return (this.config.get<string>('APP_URL') ?? 'http://localhost:2700').replace(/\/$/, ''); }

  /** Prévia padrão do Balcão (link que não é de uma loja no ar). */
  private platform(): ShareMeta {
    return {
      type: 'website', siteName: 'Balcão ERP', url: `${this.front}/`, title: 'Balcão: seu sistema e sua loja online com a cara da sua marca',
      description: 'Tela de vendas, comprovante e site nas cores e com a logo da sua loja. Caixa, Pix, maquininha e loja online com o mesmo estoque. 30 dias grátis.',
      image: `${this.front}/og-image.jpg?v=2`, imageAlt: 'Balcão ERP', imageSize: { w: W, h: H },
    };
  }

  @Get('share')
  async share(@Query('path') path: string | undefined, @Query('host') host: string | undefined, @Res() res: Response) {
    const meta = await this.build(String(path ?? '/'), host ? String(host).slice(0, 253) : null).catch(() => this.platform());
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.send(renderShareHtml(meta));
  }

  private async build(path: string, host: string | null): Promise<ShareMeta> {
    const t = parseSharePath(path, !!host);
    const slug = host ? (await this.domains.byHost(host)).slug : t.slug;
    if (!slug) return this.platform();
    const { store, enterprise } = await this.stores.publicBySlug(slug);
    const base = storeUrl(this.front, store);
    const info: ShareStore = {
      name: store.name, tagline: store.tagline, about: store.about, seoTitle: store.seo?.title, seoDescription: store.seo?.description,
      installments: store.theme?.installments ?? 0, catalogOnly: store.mode === 'whatsapp', accent: store.theme?.accent,
    };
    if (t.productId) {
      const eid = String(store.enterpriseId);
      const [raw] = await this.promotions.decorate(eid, [await this.products.publicGet(eid, t.productId)]);
      const c = card(raw as P, false);
      const hasPhoto = !!((raw as P).images?.[0] || (raw as P).image);
      const v = new Date((raw as unknown as { updatedAt?: Date }).updatedAt ?? 0).getTime();
      const m = productMeta(info, { name: c.name, description: c.description, priceCents: c.fromCents > c.priceCents ? c.fromCents : c.priceCents, compareAtCents: c.compareAtCents, inStock: c.inStock, fromPrice: c.fromCents > c.priceCents },
        `${base}/p/${c.id}`, hasPhoto ? `${this.api}/public/store/${store.slug}/products/${c.id}/share.jpg?v=${v}` : this.storeImage(store, enterprise));
      return { ...m, imageSize: { w: W, h: H } };
    }
    return { ...storeMeta(info, base, this.storeImage(store, enterprise)), imageSize: { w: W, h: H } };
  }

  private storeImage(store: { slug: string; banner?: string; slides?: { image: string }[]; logo?: string }, ent: { logo?: string }) {
    return store.banner || store.slides?.find((x) => x.image)?.image || store.logo || ent.logo ? `${this.api}/public/store/${store.slug}/share.jpg` : `${this.front}/og-image.jpg?v=2`;
  }

  @Get('store/:slug/products/:id/share.jpg')
  async productImage(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Res() res: Response) {
    const { store } = await this.stores.publicBySlug(slug);
    const p = await this.products.publicGet(String(store.enterpriseId), id);
    return this.jpeg(p.images?.[0] || p.image || '', 'contain', res);
  }

  @Get('store/:slug/share.jpg')
  async storeShareImage(@Param('slug') slug: string, @Res() res: Response) {
    const { store, enterprise } = await this.stores.publicBySlug(slug);
    const wide = store.banner || store.slides?.find((x) => x.image)?.image;
    return this.jpeg(wide || store.logo || enterprise.logo || '', wide ? 'cover' : 'contain', res);
  }

  /** Foto → JPEG 1200×630 (fundo branco; produto e logo inteiros, banner recortado). Só lê arquivos nossos ou data URL. */
  private async jpeg(src: string, fit: 'contain' | 'cover', res: Response) {
    let buf: Buffer | null = null;
    const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (m) buf = Buffer.from(m[1], 'base64');
    else if (/^https?:\/\//.test(src)) {
      buf = await this.storage.readOwn(src);
      // Foto num endereço de fora: o servidor não busca (nada de baixar URL de terceiros); o leitor busca direto.
      if (!buf) { res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); return res.redirect(302, src); }
    }
    if (!buf) throw new NotFoundException('Foto não encontrada');
    const out = await sharp(buf, { limitInputPixels: 50_000_000 }).rotate()
      .resize(W, H, { fit, background: '#ffffff', withoutEnlargement: false })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(out);
  }
}
