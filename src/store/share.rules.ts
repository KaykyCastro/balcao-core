/**
 * "Link mágico": a prévia que WhatsApp, Instagram, Facebook, X, LinkedIn e Telegram montam quando alguém cola o link
 * de uma loja ou de um produto. Esses leitores não rodam o site (React), só leem o HTML; o Caddy manda só eles para
 * `/public/share`, que devolve uma página mínima com as tags Open Graph daquele produto ou loja.
 * Aqui ficam as regras puras: entender o endereço, montar título/descrição e escrever o HTML (tudo escapado).
 */

/** Leitores de prévia de link (não inclui o Google: ele roda o site e vê o mesmo que o cliente). */
export const SHARE_BOT_RE = /facebookexternalhit|facebot|whatsapp|twitterbot|linkedinbot|slackbot|telegrambot|discordbot|pinterest|skypeuripreview|redditbot|embedly|iframely|vkshare|snapchat|bitlybot|tumblr|mastodon|applebot/i;

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const OID = /^[a-f0-9]{24}$/;

/** O que o link aponta: a loja (página inicial ou qualquer outra página dela) ou um produto. */
export type ShareTarget = { slug: string | null; productId: string | null };

/**
 * Endereço do link → loja e produto. Na plataforma: `/loja/:slug` e `/loja/:slug/p/:id`. Num domínio próprio
 * (`custom`), a loja vem do domínio e o caminho é `/` ou `/p/:id`. Qualquer outra coisa → nada (prévia padrão).
 */
export function parseSharePath(path: string, custom = false): ShareTarget {
  const clean = String(path ?? '').split(/[?#]/)[0].slice(0, 300).toLowerCase();
  const parts = clean.split('/').filter(Boolean);
  if (custom) {
    const pid = parts[0] === 'p' && OID.test(parts[1] ?? '') ? parts[1] : null;
    return { slug: null, productId: pid };
  }
  if (parts[0] !== 'loja' || !SLUG.test(parts[1] ?? '')) return { slug: null, productId: null };
  const pid = parts[2] === 'p' && OID.test(parts[3] ?? '') ? parts[3] : null;
  return { slug: parts[1], productId: pid };
}

export const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

export interface ShareMeta {
  type: 'product' | 'website';
  title: string; description: string; url: string; siteName: string;
  image: string | null; imageAlt: string; imageSize?: { w: number; h: number };
  price?: { cents: number; available: boolean };
  /** Cor da loja (barra do navegador no celular). */
  themeColor?: string;
}

export interface ShareProduct { name: string; description: string; priceCents: number; compareAtCents: number | null; inStock: boolean; fromPrice?: boolean }
export interface ShareStore { name: string; tagline?: string; about?: string; seoTitle?: string; seoDescription?: string; installments?: number; catalogOnly?: boolean; accent?: string }

/** Produto: "Vestido midi · R$ 129,90" e, na descrição, desconto real, parcelas da loja, o texto do produto e a loja. */
export function productMeta(store: ShareStore, p: ShareProduct, url: string, image: string | null): ShareMeta {
  const price = `${p.fromPrice ? 'a partir de ' : ''}${brl(p.priceCents)}`;
  const off = p.compareAtCents && p.compareAtCents > p.priceCents ? Math.round((1 - p.priceCents / p.compareAtCents) * 100) : 0;
  const n = store.installments ?? 0;
  const lead = [
    off >= 1 ? `De ${brl(p.compareAtCents!)} por ${price} (${off}% OFF)` : price,
    !store.catalogOnly && n > 1 && p.priceCents >= n * 500 ? `ou ${n}x de ${brl(Math.ceil(p.priceCents / n))} sem juros` : '',
    p.inStock ? '' : 'Esgotado no momento',
  ].filter(Boolean).join(' · ');
  const body = cut(p.description, 160);
  return {
    type: 'product',
    title: cut(`${p.name} · ${price}`, 90),
    description: cut([lead, body, `Na ${store.name}`].filter(Boolean).join('. ').replace(/\.\./g, '.'), 280),
    url, siteName: cut(store.name, 60), image, imageAlt: cut(`Foto de ${p.name}`, 120),
    price: { cents: p.priceCents, available: p.inStock },
    themeColor: store.accent,
  };
}

/** Loja: título do SEO (ou o nome) e a descrição do SEO, o slogan ou o "sobre". */
export function storeMeta(store: ShareStore, url: string, image: string | null): ShareMeta {
  const title = cut(store.seoTitle || (store.tagline ? `${store.name} · ${store.tagline}` : store.name), 90);
  const description = cut(store.seoDescription || store.tagline || store.about || `Veja os produtos da ${store.name} e compre online.`, 280);
  return { type: 'website', title, description, url, siteName: cut(store.name, 60), image, imageAlt: cut(`${store.name}`, 120), themeColor: store.accent };
}

const esc = (s: string) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' })[c]!);

/** Página mínima só com as tags (o leitor de prévia não precisa de mais nada). Sem script e sem redirecionar. */
export function renderShareHtml(m: ShareMeta): string {
  const tag = (k: string, v: string | number | undefined | null, attr: 'property' | 'name' = 'property') => (v === undefined || v === null || v === '' ? '' : `<meta ${attr}="${k}" content="${esc(String(v))}">`);
  const tags = [
    `<meta charset="utf-8">`, `<title>${esc(m.title)}</title>`,
    tag('description', m.description, 'name'), `<link rel="canonical" href="${esc(m.url)}">`, tag('theme-color', m.themeColor, 'name'),
    tag('og:type', m.type === 'product' ? 'product' : 'website'), tag('og:site_name', m.siteName), tag('og:locale', 'pt_BR'),
    tag('og:url', m.url), tag('og:title', m.title), tag('og:description', m.description),
    tag('og:image', m.image), tag('og:image:secure_url', m.image?.startsWith('https://') ? m.image : null),
    tag('og:image:type', m.image && m.imageSize ? 'image/jpeg' : null), tag('og:image:width', m.image ? m.imageSize?.w : null), tag('og:image:height', m.image ? m.imageSize?.h : null),
    tag('og:image:alt', m.image ? m.imageAlt : null),
    ...(m.price ? [tag('product:price:amount', (m.price.cents / 100).toFixed(2)), tag('product:price:currency', 'BRL'), tag('product:availability', m.price.available ? 'in stock' : 'out of stock'),
      tag('og:price:amount', (m.price.cents / 100).toFixed(2)), tag('og:price:currency', 'BRL')] : []),
    tag('twitter:card', m.image ? 'summary_large_image' : 'summary', 'name'), tag('twitter:title', m.title, 'name'), tag('twitter:description', m.description, 'name'), tag('twitter:image', m.image, 'name'),
  ].filter(Boolean);
  return `<!doctype html><html lang="pt-BR"><head>${tags.join('')}</head><body><h1>${esc(m.title)}</h1><p>${esc(m.description)}</p><p><a href="${esc(m.url)}">${esc(m.url)}</a></p></body></html>`;
}
