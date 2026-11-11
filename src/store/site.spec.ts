import { FAVICON_RE, hasCheckout, MODE_RULES, modeOf, SELECTABLE_MODES } from './store.rules';
import { SeoController } from './seo.controller';

describe('tipos de loja', () => {
  it('escolhíveis: E-commerce, Catálogo online e Cardápio; Loja virtual só para quem já usa', () => {
    expect(SELECTABLE_MODES).toEqual(['ecommerce', 'whatsapp', 'menu']);
    expect(SELECTABLE_MODES).not.toContain('catalog');
  });
  it('Catálogo online não tem checkout nem entrega no site', () => {
    expect(hasCheckout('whatsapp')).toBe(false);
    expect(hasCheckout('ecommerce')).toBe(true);
    expect(MODE_RULES.whatsapp.shipping).toEqual([]);
  });
  it('loja gravada como catálogo online continua no modo', () => expect(modeOf({ mode: 'whatsapp' })).toBe('whatsapp'));
  it('favicon só imagem (sem SVG, que pode carregar script)', () => {
    expect(FAVICON_RE.test('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(FAVICON_RE.test('data:image/x-icon;base64,AAABAA==')).toBe(true);
    expect(FAVICON_RE.test('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
  });
});

describe('SEO: sitemaps e manifest', () => {
  const res = () => { const r: any = { headers: {}, setHeader: jest.fn((k, v) => { r.headers[k] = v; }), send: jest.fn((b) => { r.body = b; }), redirect: jest.fn() }; return r; };
  const cfg = { get: (k: string) => ({ FRONTEND_URL: 'https://balcao.app', APP_URL: 'https://api.balcao.app' } as Record<string, string>)[k] } as any;
  const store = { slug: 'moda&cia', enterpriseId: 'e1', name: 'Moda & Cia', tagline: 'Roupas', theme: { accent: '#6E1F2E', background: 'custom', bgColor: '#FFFFFF' }, seo: { title: '', description: '', favicon: 'data:image/png;base64,AAAA' }, logo: '' };
  const stores = { sitemapStores: jest.fn(async () => [{ slug: 'moda&cia', enterpriseId: 'e1', updatedAt: new Date('2026-11-01T10:00:00Z') }]), publicBySlug: jest.fn(async () => ({ store, enterprise: { logo: '' } })) };
  const products = { sitemapEntries: jest.fn(async () => [{ id: 'p1', updatedAt: new Date('2026-11-02T10:00:00Z') }]) };
  const ctl = new SeoController(stores as any, products as any, cfg);

  it('índice aponta para o sitemap do Balcão e um de cada loja (com escape de XML)', async () => {
    const r = res(); await ctl.index(r);
    expect(r.headers['Content-Type']).toMatch(/xml/);
    expect(r.body).toContain('<loc>https://api.balcao.app/public/sitemap-balcao.xml</loc>');
    expect(r.body).toContain('/public/store/moda&amp;cia/sitemap.xml');
    expect(r.body).toContain('<lastmod>2026-11-01</lastmod>');
  });
  it('sitemap da loja lista a página inicial e cada produto no endereço do site', async () => {
    const r = res(); await ctl.store('moda&cia', r);
    expect(r.body).toContain('<loc>https://balcao.app/loja/moda&amp;cia/p/p1</loc>');
    expect(r.body).toContain('<lastmod>2026-11-02</lastmod>');
  });
  it('sitemap do Balcão não inclui a área logada', () => {
    const r = res(); ctl.platform(r);
    expect(r.body).toContain('<loc>https://balcao.app/lojas</loc>');
    expect(r.body).not.toContain('/app');
  });
  it('manifest com nome, cor e ícone da loja, abrindo na própria loja', async () => {
    const r = res(); await ctl.manifest('moda&cia', r);
    const m = JSON.parse(r.body);
    expect(m).toMatchObject({ name: 'Moda & Cia', start_url: 'https://balcao.app/loja/moda&cia', theme_color: '#6E1F2E', background_color: '#FFFFFF' });
    expect(m.icons[0].src).toBe('https://api.balcao.app/public/store/moda&cia/icon');
  });
  it('ícone: devolve a imagem como arquivo, com nosniff', async () => {
    const r = res(); await ctl.icon('moda&cia', r);
    expect(r.headers['Content-Type']).toBe('image/png');
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(Buffer.isBuffer(r.send.mock.calls[0][0])).toBe(true);
  });
});

describe('schema da loja: página do construtor', () => {
  it('guarda a página publicada e o rascunho como estão (seções, componentes e campo "type")', async () => {
    const mongoose = require('mongoose');
    const { StoreSchemaFactory } = require('./schema/store.schema');
    const Model = mongoose.models.StoreSpec ?? mongoose.model('StoreSpec', StoreSchemaFactory);
    const page = { v: 1, sections: [{ id: 'sec1', style: { padY: 'lg' }, blocks: [{ id: 'blk1', type: 'heading', span: 1, hideOn: 'none', props: { text: 'Oi' } }] }] };
    const d = new Model({ enterpriseId: new mongoose.Types.ObjectId(), slug: 'teste', name: 'Teste', page, pageDraft: page });
    await expect(d.validate()).resolves.toBeUndefined();
    expect(d.page.sections[0].blocks[0]).toMatchObject({ type: 'heading', props: { text: 'Oi' } });
  });
});

import { priceWithOnlineFee } from './store.rules';
describe('preço com a taxa da loja online', () => {
  it('deixa o mesmo valor líquido do balcão (arredonda para cima)', () => {
    expect(priceWithOnlineFee(10000, 300)).toBe(10310);
    expect(Math.floor(10310 * (1 - 0.03))).toBeGreaterThanOrEqual(10000);
    expect(priceWithOnlineFee(1990, 150)).toBe(2021);
    expect(priceWithOnlineFee(5000, 0)).toBe(5000);
  });
});
