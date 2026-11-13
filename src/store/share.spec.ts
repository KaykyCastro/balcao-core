import { SHARE_BOT_RE, parseSharePath, productMeta, renderShareHtml, storeMeta } from './share.rules';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const store = { name: 'Ateliê Flor', tagline: 'Moda feminina', installments: 3, accent: '#E0457B' };

describe('link mágico (prévia ao compartilhar)', () => {
  it('entende o endereço da loja e do produto na plataforma e no domínio próprio', () => {
    expect(parseSharePath(`/loja/atelie-flor/p/${ID}`)).toEqual({ slug: 'atelie-flor', productId: ID });
    expect(parseSharePath('/loja/atelie-flor')).toEqual({ slug: 'atelie-flor', productId: null });
    expect(parseSharePath('/loja/atelie-flor/politicas?x=1')).toEqual({ slug: 'atelie-flor', productId: null });
    expect(parseSharePath(`/p/${ID}`, true)).toEqual({ slug: null, productId: ID });
    expect(parseSharePath('/', true)).toEqual({ slug: null, productId: null });
    expect(parseSharePath('/app/vendas')).toEqual({ slug: null, productId: null });
    expect(parseSharePath('/loja/../../etc')).toEqual({ slug: null, productId: null });
    expect(parseSharePath('/loja/x/p/nao-e-id')).toEqual({ slug: 'x', productId: null });
  });

  it('produto: nome e preço no título; desconto real, parcelas e a loja na descrição', () => {
    const m = productMeta(store, { name: 'Vestido midi', description: 'Tecido leve,\n forrado.', priceCents: 12990, compareAtCents: 15990, inStock: true }, 'https://x/p', 'https://api/img.jpg');
    expect(m.title).toBe('Vestido midi · R$ 129,90');
    expect(m.description).toBe('De R$ 159,90 por R$ 129,90 (19% OFF) · ou 3x de R$ 43,30 sem juros. Tecido leve, forrado.. Na Ateliê Flor'.replace('..', '.'));
    expect(m.price).toEqual({ cents: 12990, available: true });
  });

  it('produto esgotado, sem parcelas em catálogo e "a partir de" com adicionais', () => {
    const m = productMeta({ ...store, catalogOnly: true }, { name: 'Pizza', description: '', priceCents: 4000, compareAtCents: null, inStock: false, fromPrice: true }, 'u', null);
    expect(m.title).toBe('Pizza · a partir de R$ 40,00');
    expect(m.description).toBe('a partir de R$ 40,00 · Esgotado no momento. Na Ateliê Flor');
  });

  it('loja: usa o SEO, senão o slogan', () => {
    expect(storeMeta({ ...store, seoTitle: 'Ateliê Flor | Vestidos' }, 'u', null).title).toBe('Ateliê Flor | Vestidos');
    expect(storeMeta(store, 'u', null)).toMatchObject({ title: 'Ateliê Flor · Moda feminina', description: 'Moda feminina' });
  });

  it('HTML escapa tudo e não tem script', () => {
    const html = renderShareHtml(productMeta(store, { name: '"><script>alert(1)</script>', description: '', priceCents: 100, compareAtCents: null, inStock: true }, 'https://x/p', 'https://api/i.jpg'));
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(html).toContain('<meta property="og:image" content="https://api/i.jpg">');
    expect(html).toContain('<meta property="product:price:amount" content="1.00">');
  });

  it('reconhece os leitores de prévia, não o Google nem um navegador', () => {
    for (const ua of ['facebookexternalhit/1.1', 'WhatsApp/2.23.20.0 A', 'Twitterbot/1.0', 'LinkedInBot/1.0', 'TelegramBot (like TwitterBot)']) expect(SHARE_BOT_RE.test(ua)).toBe(true);
    for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36']) expect(SHARE_BOT_RE.test(ua)).toBe(false);
  });
});
