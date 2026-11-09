import { BadRequestException } from '@nestjs/common';
import { BODY_FONT_KEYS, FONT_KEYS } from './fonts.rules';

/**
 * Construtor de sites por seções. A página da loja é uma lista de seções; cada seção tem estilo próprio
 * (fundo, espaçamento, largura, colunas) e uma lista de componentes. Tudo que chega do cliente passa por
 * `sanitizePage`: tipo desconhecido, campo fora da lista ou valor inválido não entra no banco.
 * O catálogo do front (balcao-web/src/features/builder/catalog.ts) usa os mesmos nomes de campo.
 */

type F =
  | { k: 'text'; max: number }
  | { k: 'long'; max: number }
  | { k: 'enum'; o: readonly string[] }
  | { k: 'int'; min: number; max: number }
  | { k: 'bool' }
  | { k: 'color' }
  | { k: 'image' }
  | { k: 'video' }
  | { k: 'link' }
  | { k: 'icon' }
  | { k: 'id' }
  | { k: 'ids'; max: number }
  | { k: 'date' }
  | { k: 'list'; max: number; item: Record<string, F> };

const t = (max: number): F => ({ k: 'text', max });
const L = (max: number): F => ({ k: 'long', max });
const e = (...o: string[]): F => ({ k: 'enum', o });
const n = (min: number, max: number): F => ({ k: 'int', min, max });
const B: F = { k: 'bool' }, C: F = { k: 'color' }, IMG: F = { k: 'image' }, VID: F = { k: 'video' }, LINK: F = { k: 'link' }, ICON: F = { k: 'icon' }, ID: F = { k: 'id' }, DATE: F = { k: 'date' };
const list = (max: number, item: Record<string, F>): F => ({ k: 'list', max, item });
const ids = (max: number): F => ({ k: 'ids', max });

const ALIGN = e('start', 'center', 'end');
const RATIO = e('auto', '1:1', '4:3', '3:4', '16:9', '9:16', '21:9');
const HEIGHT = e('sm', 'md', 'lg', 'xl', 'screen');
const TONE3 = e('brand', 'dark', 'light');
/** Estilos de cartão de produto (cada um vira um componente de cartão na vitrine). */
export const PRODUCT_CARDS = ['classic', 'minimal', 'soft', 'market', 'gallery', 'jewel', 'round', 'retail', 'polaroid', 'street'] as const;
const CARD = e(...PRODUCT_CARDS);
const SOURCE = e('all', 'offers', 'new', 'category', 'selected', 'cheap');
const FONT = e('store', 'serif', 'sans');
const SOCIAL = e('instagram', 'whatsapp', 'facebook', 'tiktok', 'youtube', 'site');

export const BLOCKS: Record<string, Record<string, F>> = {
  // vitrine em mosaico (mosaico, pílulas, vitrine limpa em abas, banners em alta, mural de avaliações)
  heroMosaic: { image: IMG, bg: C, kicker: t(60), title: t(120), button: t(40), link: LINK, items: list(2, { image: IMG, title: t(80), link: LINK, textColor: e('light', 'dark') }), height: e('md', 'lg', 'xl') },
  pillLinks: { fromCategories: B, items: list(8, { label: t(40), link: LINK }), style: e('outline', 'solid'), uppercase: B, spread: B },
  productShowcase: { tabs: list(3, { label: t(40), source: e('new', 'sold', 'offers', 'all', 'cheap', 'category'), categoryId: ID }), limit: n(4, 24), columns: n(2, 5), tag: e('category', 'none') },
  featureBanners: { title: t(80), items: list(3, { image: IMG, title: t(120), text: t(160), button: t(40), link: LINK, textColor: e('light', 'dark') }), height: e('md', 'lg', 'xl') },
  reviewWall: { title: t(120), photosOnly: B, limit: n(3, 24), showCount: B },
  // código: o lojista escreve JSX restrito; a árvore e o CSS (props.out) são gerados no servidor ao salvar (code/code.service.ts)
  code: { code: L(20_000) },
  // varejo grande (eletro, eletrônicos, utilidades): faixa de mensagens, departamentos com foto, catálogo com filtros, trilho de ofertas
  promoStrip: { items: list(3, { text: t(80), link: LINK }), style: TONE3 },
  categoryIcons: { title: t(60), fromCategories: B, items: list(12, { image: IMG, label: t(40), link: LINK }), size: e('md', 'lg') },
  productCatalog: { title: t(120), filters: B, perPage: n(8, 24), columns: n(2, 5), sort: e('relevance', 'sold', 'price_asc', 'price_desc', 'new') },
  dealsRail: { title: t(120), source: e('offers', 'new', 'sold', 'all', 'category', 'selected'), categoryId: ID, ids: ids(24), limit: n(4, 24), showAll: B },
  // ótica e guias (servem para outras lojas também): formatos, rosto, lentes, medidas, receita, agenda, cores, cuidados
  frameShapes: { title: t(120), subtitle: L(300), items: list(8, { shape: e('round', 'square', 'aviator', 'cat', 'rect', 'hex', 'oval', 'browline'), label: t(40), link: LINK }), style: e('outline', 'filled'), align: ALIGN },
  faceGuide: { title: t(120), text: L(400), items: list(6, { face: e('oval', 'round', 'square', 'heart', 'diamond', 'long'), name: t(40), tip: L(240), link: LINK }) },
  lensOptions: { title: t(120), text: L(300), items: list(8, { icon: ICON, title: t(60), text: L(240), note: t(60) }), columns: n(2, 4), style: e('cards', 'list') },
  measureGuide: { title: t(120), text: L(600), lens: n(30, 70), bridge: n(10, 30), temple: n(100, 160), note: L(300) },
  prescriptionCta: { kicker: t(60), title: t(120), text: L(400), steps: list(4, { text: t(120) }), button: t(40), link: LINK, style: TONE3 },
  appointment: { title: t(120), text: L(400), services: list(6, { name: t(60), detail: t(120) }), button: t(40), link: LINK, showHours: B, image: IMG },
  colorSwatches: { title: t(120), items: list(12, { color: C, name: t(40), link: LINK }), size: e('sm', 'md', 'lg'), align: ALIGN },
  careTips: { title: t(120), items: list(8, { icon: ICON, title: t(60), text: L(240) }), columns: n(2, 4) },
  // navegação
  navbar: { title: t(60), showLogo: B, links: list(8, { label: t(40), link: LINK }), search: B, cart: B, account: B, categories: B, style: e('light', 'dark', 'brand', 'transparent'), layout: e('left', 'center', 'split', 'stacked', 'department'), sticky: B, topLeft: t(60), topRight: t(60), highlightFirst: B, helpLabel: t(40), helpLink: LINK },
  announcement: { text: t(160), link: LINK, style: TONE3, marquee: B },
  footer: { about: B, columns: list(4, { title: t(40), links: list(8, { label: t(40), link: LINK }) }), social: B, contacts: B, policies: B, legal: B, payments: B, style: e('light', 'dark', 'brand') },
  search: { placeholder: t(80), size: e('md', 'lg'), categories: B },
  categoryNav: { style: e('pills', 'underline', 'buttons'), align: ALIGN },
  breadcrumb: { label: t(60) },
  // texto
  heading: { text: t(160), subtitle: L(300), level: e('h1', 'h2', 'h3'), size: e('sm', 'md', 'lg', 'xl', '2xl'), align: ALIGN, color: C, weight: e('normal', 'bold'), italic: B, uppercase: B },
  text: { text: L(3000), size: e('sm', 'md', 'lg'), align: ALIGN, color: C, muted: B },
  button: { label: t(40), link: LINK, style: e('solid', 'outline', 'ghost', 'link', 'dark'), size: e('sm', 'md', 'lg'), align: ALIGN, icon: ICON, full: B },
  buttons: { items: list(4, { label: t(40), link: LINK, style: e('solid', 'outline', 'ghost', 'dark') }), align: ALIGN, size: e('sm', 'md', 'lg') },
  badge: { text: t(40), icon: ICON, tone: e('brand', 'dark', 'light', 'success', 'warning'), align: ALIGN },
  quote: { text: L(600), author: t(80), role: t(80), image: IMG, stars: n(0, 5), style: e('plain', 'card', 'big'), align: ALIGN },
  testimonials: { items: list(9, { text: L(400), author: t(80), role: t(80), image: IMG, stars: n(0, 5) }), columns: n(1, 3), style: e('card', 'plain') },
  list: { items: list(20, { text: t(160) }), icon: ICON, columns: n(1, 3), size: e('sm', 'md', 'lg') },
  // mídia
  image: { src: IMG, alt: t(160), link: LINK, ratio: RATIO, fit: e('cover', 'contain'), rounded: B, shadow: B, caption: t(160) },
  gallery: { images: list(24, { src: IMG, alt: t(160), link: LINK }), columns: n(2, 6), ratio: RATIO, gap: e('none', 'sm', 'md', 'lg'), rounded: B, style: e('grid', 'masonry', 'strip') },
  video: { src: VID, poster: IMG, autoplay: B, loop: B, muted: B, controls: B, ratio: RATIO, rounded: B },
  banner: { image: IMG, video: VID, title: t(120), text: L(300), button: t(40), link: LINK, button2: t(40), link2: LINK, height: HEIGHT, align: ALIGN, vAlign: ALIGN, overlay: n(0, 90), textColor: e('light', 'dark'), rounded: B },
  carousel: { slides: list(10, { image: IMG, title: t(120), text: L(300), button: t(40), link: LINK }), height: HEIGHT, autoplay: n(0, 15), overlay: n(0, 90), align: ALIGN, textColor: e('light', 'dark'), rounded: B, arrows: B, dots: B },
  logos: { images: list(16, { src: IMG, alt: t(80), link: LINK }), grayscale: B, size: e('sm', 'md', 'lg'), marquee: B },
  icon: { name: ICON, size: e('sm', 'md', 'lg', 'xl'), color: C, align: ALIGN, style: e('plain', 'circle', 'square') },
  feature: { icon: ICON, title: t(80), text: L(300), link: LINK, align: ALIGN, style: e('plain', 'card', 'side') },
  features: { items: list(12, { icon: ICON, title: t(80), text: L(300) }), columns: n(1, 4), style: e('plain', 'card', 'line', 'side'), align: ALIGN },
  stats: { items: list(6, { value: t(20), label: t(80) }), align: ALIGN, style: e('plain', 'card', 'divided') },
  card: { image: IMG, title: t(120), text: L(600), button: t(40), link: LINK, style: e('card', 'plain', 'overlay', 'side'), ratio: RATIO },
  steps: { items: list(8, { title: t(80), text: L(300) }), style: e('line', 'cards') },
  spacer: { size: e('xs', 'sm', 'md', 'lg', 'xl', '2xl') },
  divider: { style: e('line', 'dashed', 'dots', 'thick'), width: e('short', 'half', 'full') },
  // loja (dados reais)
  productGrid: { title: t(120), source: SOURCE, categoryId: ID, ids: ids(24), limit: n(1, 24), columns: n(1, 6), card: CARD, showAll: B, sort: e('relevance', 'new', 'price_asc', 'price_desc', 'name') },
  productCarousel: { title: t(120), source: SOURCE, categoryId: ID, ids: ids(24), limit: n(2, 24), card: CARD, showAll: B },
  productSpotlight: { productId: ID, title: t(120), text: L(400), button: t(40), layout: e('image-left', 'image-right', 'stacked') },
  categories: { title: t(120), style: e('grid', 'circles', 'tiles', 'pills', 'list'), ids: ids(24), limit: n(1, 24), columns: n(2, 8) },
  coupons: { title: t(120), style: e('tickets', 'compact'), limit: n(1, 12) },
  reels: { title: t(120), limit: n(1, 12) },
  countdown: { title: t(120), text: L(300), until: DATE, style: TONE3, button: t(40), link: LINK, endedText: t(120) },
  whatsapp: { label: t(40), message: L(300), style: e('button', 'floating', 'card'), align: ALIGN },
  contact: { title: t(120), whatsapp: B, instagram: B, email: B, address: B, style: e('list', 'cards') },
  hours: { title: t(120), text: L(600) },
  shipping: { title: t(120), style: e('list', 'cards') },
  faq: { title: t(120), items: list(20, { q: t(200), a: L(1000) }), auto: B },
  about: { title: t(120), text: L(3000), image: IMG, layout: e('text', 'image-left', 'image-right') },
  trust: { items: list(6, { icon: ICON, title: t(60), text: t(160) }), style: e('plain', 'card', 'bar') },
  cashback: { title: t(120), style: e('banner', 'badge') },
  payments: { title: t(120), style: e('icons', 'list') },
  social: { links: list(6, { network: SOCIAL, url: LINK }), fromStore: B, style: e('icons', 'buttons'), align: ALIGN },
  map: { address: t(240), title: t(120) },
  // sofisticados (linha editorial de moda e luxo)
  editorialHero: { image: IMG, video: VID, kicker: t(60), title: t(120), link: LINK, linkLabel: t(40), height: e('lg', 'xl', 'screen'), align: ALIGN, position: e('bottom', 'center'), overlay: n(0, 90), font: FONT },
  splitHero: { items: list(3, { image: IMG, title: t(60), label: t(40), link: LINK }), height: e('lg', 'xl', 'screen'), font: FONT },
  lookbook: { title: t(120), text: L(300), images: list(6, { src: IMG, caption: t(80), link: LINK }), layout: e('asym', 'trio', 'duo'), font: FONT },
  collectionIndex: { title: t(120), items: list(10, { name: t(60), link: LINK, image: IMG }), fromCategories: B, font: FONT },
  story: { kicker: t(60), statement: L(400), text: L(1200), image: IMG, signature: t(80), layout: e('image-left', 'image-right'), font: FONT },
  press: { items: list(6, { quote: L(200), source: t(60) }), style: e('row', 'stacked'), font: FONT },
  luxeProducts: { title: t(120), source: SOURCE, categoryId: ID, ids: ids(24), limit: n(2, 12), columns: n(2, 4), showPrice: B, hoverImage: B, align: ALIGN, font: FONT },
  signature: { productId: ID, kicker: t(60), details: list(6, { label: t(40), value: t(120) }), button: t(40), font: FONT },
  concierge: { kicker: t(60), title: t(120), text: L(400), button: t(40), link: LINK, image: IMG, style: e('dark', 'light'), font: FONT },
  manifesto: { items: list(8, { text: t(60) }), size: e('md', 'lg', 'xl'), marquee: B, separator: e('star', 'dot', 'line'), font: FONT },
  offsetImage: { image: IMG, kicker: t(60), title: t(120), text: L(600), button: t(40), link: LINK, side: e('left', 'right'), tone: e('light', 'dark'), font: FONT },
  feed: { title: t(120), handle: t(60), link: LINK, images: list(12, { src: IMG, link: LINK }), columns: n(3, 6) },
  // navegação e faixas
  topBar: { text: t(120), whatsapp: B, links: list(4, { label: t(40), link: LINK }), style: TONE3 },
  anchorNav: { items: list(8, { label: t(40), link: LINK }), sticky: B, align: ALIGN },
  countdownBar: { text: t(120), until: DATE, link: LINK, style: TONE3 },
  freeShippingBar: { text: t(120), style: TONE3 },
  // topos de página
  heroMinimal: { kicker: t(60), title: t(160), text: L(300), button: t(40), link: LINK, button2: t(40), link2: LINK, align: ALIGN, size: e('lg', 'xl', '2xl') },
  heroGradient: { from: C, to: C, angle: n(0, 360), title: t(120), text: L(300), button: t(40), link: LINK, image: IMG, textColor: e('light', 'dark') },
  heroSearch: { image: IMG, title: t(120), text: L(200), placeholder: t(80), overlay: n(0, 90), height: HEIGHT, categories: B },
  heroProduct: { productId: ID, kicker: t(60), title: t(120), text: L(300), button: t(40), bg: C },
  parallax: { image: IMG, title: t(120), text: L(300), button: t(40), link: LINK, height: e('md', 'lg', 'xl'), overlay: n(0, 90) },
  // texto
  callout: { icon: ICON, title: t(120), text: L(600), tone: e('brand', 'info', 'success', 'warning', 'dark'), button: t(40), link: LINK },
  twoColumnText: { kicker: t(60), title: t(120), text: L(3000) },
  numberedList: { title: t(120), items: list(10, { title: t(80), text: L(300) }), columns: n(1, 3) },
  timeline: { title: t(120), items: list(12, { date: t(30), title: t(80), text: L(300) }) },
  sizeChart: { title: t(120), headers: list(8, { label: t(30) }), rows: list(20, { cells: list(8, { value: t(30) }) }), note: L(300) },
  comparison: { title: t(120), us: t(40), them: t(40), items: list(12, { label: t(80), us: B, them: B }) },
  tabsContent: { tabs: list(6, { label: t(40), text: L(2000) }) },
  ctaBanner: { title: t(120), text: L(300), button: t(40), link: LINK, style: e('brand', 'dark', 'light', 'outline'), align: ALIGN },
  quoteCarousel: { items: list(10, { text: L(400), author: t(80), role: t(80), stars: n(0, 5) }), autoplay: n(0, 15) },
  // mídia
  beforeAfter: { before: IMG, after: IMG, beforeLabel: t(30), afterLabel: t(30), ratio: RATIO },
  videoText: { src: VID, poster: IMG, title: t(120), text: L(600), button: t(40), link: LINK, side: e('left', 'right') },
  tiles: { items: list(6, { image: IMG, title: t(60), link: LINK }), columns: n(2, 4), ratio: RATIO, style: e('overlay', 'below') },
  hotspots: { title: t(120), image: IMG, points: list(8, { x: n(0, 100), y: n(0, 100), productId: ID, label: t(60) }) },
  cardsGrid: { items: list(12, { image: IMG, title: t(120), text: L(300), button: t(40), link: LINK }), columns: n(1, 4), style: e('card', 'plain', 'overlay') },
  doubleBanner: { items: list(2, { image: IMG, title: t(80), text: L(200), button: t(40), link: LINK }), height: e('sm', 'md', 'lg') },
  bannerTrio: { items: list(3, { image: IMG, title: t(80), button: t(40), link: LINK }), height: e('sm', 'md', 'lg') },
  marqueeImages: { images: list(16, { src: IMG, link: LINK }), height: e('sm', 'md', 'lg'), speed: e('slow', 'normal', 'fast') },
  polaroids: { title: t(120), images: list(8, { src: IMG, caption: t(60), link: LINK }) },
  // produtos
  productTabs: { title: t(120), tabs: list(4, { label: t(30), source: SOURCE, categoryId: ID }), limit: n(2, 12), columns: n(2, 6), card: CARD },
  productList: { title: t(120), source: SOURCE, categoryId: ID, ids: ids(24), limit: n(2, 12), columns: n(1, 3), numbered: B },
  dealOfDay: { productId: ID, title: t(120), until: e('midnight', 'date'), date: DATE, button: t(40) },
  categoryProducts: { ids: ids(8), maxCategories: n(1, 8), limit: n(2, 12), card: CARD },
  bundle: { title: t(120), text: L(300), ids: ids(4), button: t(40) },
  lowStock: { title: t(120), max: n(1, 10), limit: n(2, 12), card: CARD },
  couponHero: { code: t(40), title: t(120), text: L(300), style: TONE3 },
  scrollingProducts: { title: t(120), source: SOURCE, categoryId: ID, limit: n(4, 20), speed: e('slow', 'normal', 'fast') },
  categorySlider: { title: t(120), ids: ids(24), style: e('tall', 'square') },
  // informações
  team: { title: t(120), items: list(12, { image: IMG, name: t(60), role: t(60), text: L(300) }), columns: n(2, 4) },
  guarantee: { icon: ICON, title: t(120), text: L(600), button: t(40), link: LINK, style: e('card', 'plain', 'badge') },
  policiesLinks: { title: t(120), style: e('cards', 'list') },
  deliveryArea: { title: t(120), text: L(600), areas: list(30, { name: t(60) }) },
  whatsForm: { title: t(120), text: L(300), button: t(40), fields: list(5, { label: t(40), kind: e('text', 'long', 'phone') }) },
  waveDivider: { color: C, shape: e('wave', 'curve', 'zigzag', 'slant'), flip: B, height: e('sm', 'md', 'lg') },
};
export const BLOCK_TYPES = Object.keys(BLOCKS);

const SECTION: Record<string, F> = {
  name: t(60), hidden: B, columns: n(1, 4), bg: C, bgImage: IMG, overlay: n(0, 90), text: e('auto', 'light', 'dark'),
  padY: e('none', 'sm', 'md', 'lg', 'xl'), width: e('narrow', 'normal', 'wide', 'full'), gap: e('none', 'sm', 'md', 'lg'), vAlign: ALIGN, anchor: t(40), radius: B,
};

export const MAX_SECTIONS = 60;
export const MAX_BLOCKS_PER_SECTION = 30;
export const MAX_BLOCKS = 300;

const HEX = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[a-f0-9]{24}$/;
const KEY_RE = /^[A-Za-z0-9_-]{4,24}$/;
const ANCHOR_RE = /^[a-z0-9-]{1,40}$/;
const ICON_RE = /^[a-z0-9-]{2,40}$/;
const URL_RE = /^https?:\/\/[^\s"'<>]{1,700}$/;

/** Links que o site aceita: página da loja, âncora, categoria, produto, carrinho, busca ou https. */
export function linkOk(v: string): boolean {
  return v === '' || v === 'cart' || v === 'search' || /^#[a-z0-9-]{1,40}$/.test(v) || /^cat:[a-f0-9]{24}$/.test(v) || /^p:[a-f0-9]{24}$/.test(v)
    || (/^\/[A-Za-z0-9\-._~/?=&%]{0,200}$/.test(v) && !v.startsWith('//')) || /^https:\/\/[^\s"'<>]{1,500}$/.test(v);
}

class Bad extends BadRequestException {
  constructor(msg: string) { super({ statusCode: 400, code: 'PAGE_INVALID', message: msg }); }
}

function clean(spec: Record<string, F>, raw: unknown, where: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, f] of Object.entries(spec)) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    switch (f.k) {
      case 'text': if (typeof v === 'string') out[key] = v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, f.max); break;
      case 'long': if (typeof v === 'string') out[key] = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, f.max); break;
      case 'enum': if (typeof v === 'string' && f.o.includes(v)) out[key] = v; break;
      case 'int': if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(f.max, Math.max(f.min, Math.round(v))); break;
      case 'bool': if (typeof v === 'boolean') out[key] = v; break;
      case 'color': if (typeof v === 'string' && (v === '' || HEX.test(v))) out[key] = v; break;
      case 'icon': if (typeof v === 'string' && (v === '' || ICON_RE.test(v))) out[key] = v; break;
      case 'id': if (typeof v === 'string' && (v === '' || ID_RE.test(v))) out[key] = v; break;
      case 'ids': if (Array.isArray(v)) out[key] = [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, f.max); break;
      case 'date': if (typeof v === 'string' && (v === '' || !Number.isNaN(Date.parse(v)))) out[key] = v === '' ? '' : new Date(v).toISOString(); break;
      case 'image': case 'video':
        if (typeof v !== 'string') break;
        if (v !== '' && !URL_RE.test(v)) throw new Bad(`Arquivo inválido em ${where}. Envie a imagem ou o vídeo de novo.`);
        out[key] = v; break;
      case 'link':
        if (typeof v !== 'string') break;
        if (!linkOk(v.trim())) throw new Bad(`Link inválido em ${where}. Use uma página da loja, um produto, uma categoria ou um endereço https://.`);
        out[key] = v.trim(); break;
      case 'list':
        if (Array.isArray(v)) out[key] = v.slice(0, f.max).map((it) => clean(f.item, it, where));
        break;
    }
  }
  return out;
}

/** `col`: coluna da seção onde o componente fica (0 = segue o fluxo da grade); `span`: quantas colunas ocupa no fluxo. */
export type PageBlock = { id: string; type: string; span: number; col: number; hideOn: 'none' | 'mobile' | 'desktop'; font?: BlockFont; props: Record<string, unknown> };
/** Fontes só deste componente (títulos e texto); vazio = as da loja. */
export type BlockFont = { head?: string; body?: string };
function blockFont(v: unknown): BlockFont | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>; const out: BlockFont = {};
  if (typeof r.head === 'string' && (FONT_KEYS as readonly string[]).includes(r.head)) out.head = r.head;
  if (typeof r.body === 'string' && (BODY_FONT_KEYS as readonly string[]).includes(r.body)) out.body = r.body;
  return out.head || out.body ? out : undefined;
}
export type PageSection = { id: string; style: Record<string, unknown>; blocks: PageBlock[] };
export type SitePage = { v: 1; sections: PageSection[] };

/** Valida e limpa a página inteira. Lança 400 `PAGE_INVALID` com a parte que deu problema. */
export function sanitizePage(raw: unknown): SitePage {
  const r = raw as { sections?: unknown } | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.sections)) throw new Bad('Página inválida');
  if (r.sections.length > MAX_SECTIONS) throw new Bad(`Use no máximo ${MAX_SECTIONS} seções`);
  let total = 0;
  const seen = new Set<string>();
  const key = (v: unknown, where: string) => {
    if (typeof v !== 'string' || !KEY_RE.test(v) || seen.has(v)) throw new Bad(`Identificador inválido em ${where}`);
    seen.add(v); return v;
  };
  const sections = r.sections.map((s0, i): PageSection => {
    const s = (s0 ?? {}) as { id?: unknown; style?: unknown; blocks?: unknown };
    const where = `seção ${i + 1}`;
    const style = clean(SECTION, s.style, where);
    if (typeof style.anchor === 'string') style.anchor = ANCHOR_RE.test(style.anchor) ? style.anchor : '';
    const blocks = Array.isArray(s.blocks) ? s.blocks : [];
    if (blocks.length > MAX_BLOCKS_PER_SECTION) throw new Bad(`Use no máximo ${MAX_BLOCKS_PER_SECTION} componentes por seção (${where})`);
    total += blocks.length;
    return {
      id: key(s.id, where), style,
      blocks: blocks.map((b0, j): PageBlock => {
        const b = (b0 ?? {}) as { id?: unknown; type?: unknown; span?: unknown; col?: unknown; hideOn?: unknown; font?: unknown; props?: unknown };
        const w = `${where}, componente ${j + 1}`;
        if (typeof b.type !== 'string' || !BLOCKS[b.type]) throw new Bad(`Componente desconhecido em ${w}`);
        return {
          id: key(b.id, w), type: b.type,
          span: typeof b.span === 'number' ? Math.min(4, Math.max(1, Math.round(b.span))) : 1,
          col: typeof b.col === 'number' ? Math.min(4, Math.max(0, Math.round(b.col))) : 0,
          hideOn: b.hideOn === 'mobile' || b.hideOn === 'desktop' ? b.hideOn : 'none',
          ...(blockFont(b.font) ? { font: blockFont(b.font) } : {}),
          props: clean(BLOCKS[b.type], b.props, w),
        };
      }),
    };
  });
  if (total > MAX_BLOCKS) throw new Bad(`Use no máximo ${MAX_BLOCKS} componentes na página`);
  return { v: 1, sections };
}

type Media = { kind: 'image' | 'video'; get: () => string; set: (v: string) => void };
function walk(spec: Record<string, F>, obj: Record<string, unknown>, out: Media[]) {
  for (const [key, f] of Object.entries(spec)) {
    const v = obj[key];
    if ((f.k === 'image' || f.k === 'video') && typeof v === 'string' && v) out.push({ kind: f.k, get: () => obj[key] as string, set: (x) => { obj[key] = x; } });
    else if (f.k === 'list' && Array.isArray(v)) for (const it of v) walk(f.item, it as Record<string, unknown>, out);
  }
}
/** Todas as imagens e vídeos da página, com como trocar cada um (para passar pelo StorageService). */
export function pageMedia(page: SitePage | null | undefined): Media[] {
  const out: Media[] = [];
  for (const s of page?.sections ?? []) {
    walk(SECTION, s.style, out);
    for (const b of s.blocks) if (BLOCKS[b.type]) walk(BLOCKS[b.type], b.props, out);
  }
  return out;
}
export const pageUrls = (page: SitePage | null | undefined) => pageMedia(page).map((m) => m.get());
