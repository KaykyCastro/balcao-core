import sharp from 'sharp';
import { ShareController } from './share.controller';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const res = () => {
  const r: any = { headers: {} as Record<string, string>, body: undefined as unknown, redirected: '' };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; };
  r.send = (b: unknown) => { r.body = b; return r; };
  r.redirect = (_: number, u: string) => { r.redirected = u; return r; };
  return r;
};

async function mk() {
  const photo = await sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 224, g: 69, b: 123, alpha: 1 } } }).webp().toBuffer();
  const store = { slug: 'atelie-flor', name: 'Ateliê Flor', tagline: 'Moda feminina', enterpriseId: 'e1', mode: 'ecommerce', theme: { installments: 3, accent: '#E0457B' }, seo: {}, banner: '', slides: [], logo: '' };
  const product = { _id: ID, name: 'Vestido midi', description: 'Tecido leve', price: 129.9, onlinePrice: null, trackStock: true, quantity: 5, images: ['https://r2.exemplo/enterprises/e1/products/a.webp'], image: '', categoryId: 'c1', updatedAt: new Date(0) };
  const svc = new ShareController(
    { publicBySlug: async (slug: string) => { if (slug !== 'atelie-flor') throw new Error('404'); return { store, enterprise: {} }; } } as any,
    { publicGet: async () => product } as any,
    { decorate: async (_: string, ps: unknown[]) => ps } as any,
    { byHost: async (h: string) => ({ slug: h === 'atelieflor.com.br' ? 'atelie-flor' : 'x', host: h }) } as any,
    { readOwn: async (u: string) => (u.startsWith('https://r2.exemplo/') ? photo : null) } as any,
    { get: (k: string) => ({ FRONTEND_URL: 'https://usebalcao.com', APP_URL: 'https://api.usebalcao.com' } as Record<string, string>)[k] } as any,
  );
  return { svc, store };
}

describe('link mágico: página e foto', () => {
  it('produto na plataforma: título com preço, foto JPEG da API e link da loja', async () => {
    const { svc } = await mk(); const r = res();
    await svc.share(`/loja/atelie-flor/p/${ID}`, undefined, r);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<meta property="og:title" content="Vestido midi · R$ 129,90">');
    expect(r.body).toContain(`<meta property="og:image" content="https://api.usebalcao.com/public/store/atelie-flor/products/${ID}/share.jpg?v=0">`);
    expect(r.body).toContain(`<meta property="og:url" content="https://usebalcao.com/loja/atelie-flor/p/${ID}">`);
    expect(r.body).toContain('ou 3x de R$ 43,30 sem juros');
  });

  it('domínio próprio: a loja vem do domínio', async () => {
    const { svc } = await mk(); const r = res();
    await svc.share(`/p/${ID}`, 'atelieflor.com.br', r);
    expect(r.body).toContain('Vestido midi · R$ 129,90');
  });

  it('loja inexistente ou link qualquer: prévia padrão do Balcão (sem erro)', async () => {
    const { svc } = await mk();
    for (const p of ['/loja/nao-existe', '/app/vendas']) {
      const r = res(); await svc.share(p, undefined, r);
      expect(r.body).toContain('https://usebalcao.com/og-image.jpg?v=2');
    }
  });

  it('foto do produto vira JPEG 1200×630; foto de fora não é baixada pelo servidor', async () => {
    const { svc } = await mk(); const r = res();
    await svc.productImage('atelie-flor', ID, r);
    expect(r.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(r.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 630]);
    const r2 = res();
    await (svc as any).jpeg('https://outro-site.com/foto.webp', 'contain', r2);
    expect(r2.redirected).toBe('https://outro-site.com/foto.webp');
  });
});
