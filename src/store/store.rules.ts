/** Regras puras da loja online (sem banco): endereço da loja, CEP, frete e status do pedido. */

export const RESERVED_SLUGS = new Set(['app', 'admin', 'api', 'loja', 'lojas', 'entrar', 'registrar', 'termos', 'balcao', 'checkout', 'pedido', 'pedidos', 'suporte', 'ajuda', 'www']);
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** "Bella Moda & Cia" -> "bella-moda-cia" */
export function slugify(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}
export function slugProblem(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return 'Use de 3 a 40 letras minúsculas, números ou hífen (sem começar/terminar com hífen).';
  if (slug.includes('--')) return 'Não use dois hífens seguidos.';
  if (RESERVED_SLUGS.has(slug)) return 'Esse endereço é reservado. Escolha outro.';
  return null;
}

export const onlyDigits = (s: string) => (s ?? '').replace(/\D/g, '');
export const cleanCep = (s: string) => {
  const d = onlyDigits(s);
  return d.length === 8 ? d : null;
};

export const SEGMENTS = ['roupas', 'calcados', 'perfumes', 'cosmeticos', 'acessorios', 'infantil', 'casa', 'eletronicos', 'alimentos', 'papelaria', 'pet', 'outros'] as const;
export type Segment = (typeof SEGMENTS)[number];

// ------------------------------------------------------------------ frete

export interface CepRange { from: string; to: string }
export interface ShippingConfig {
  pickup?: { enabled?: boolean; address?: string; instructions?: string };
  local?: { enabled?: boolean; name?: string; priceCents?: number; freeAboveCents?: number | null; etaText?: string; cepRanges?: CepRange[] };
  fixed?: { enabled?: boolean; name?: string; priceCents?: number; freeAboveCents?: number | null; minDays?: number; maxDays?: number };
  melhorEnvio?: { enabled?: boolean; originCep?: string; handlingDays?: number; extraFeeCents?: number; freeAboveCents?: number | null };
}
export type ShippingKind = 'pickup' | 'local' | 'fixed' | 'carrier' | 'table';

/**
 * Como a loja online funciona (Configurações da loja). Define as regras:
 * - ecommerce: vende para todo o Brasil (Correios/transportadoras, frete fixo, entrega própria e retirada). Prazos de envio em dias.
 * - catalog (loja virtual): vende na região, com entrega própria e retirada. Prazos curtos (1 dia).
 * - menu (cardápio): bares, restaurantes e delivery de comida. Mesas com comanda, delivery próprio e retirada. Prazos em horas.
 */
/** catalog = "Loja virtual" antiga (checkout com entrega local); continua para quem já usa. whatsapp = Catálogo online (sem checkout). */
export const STORE_MODES = ['ecommerce', 'whatsapp', 'catalog', 'menu'] as const;
export type StoreMode = (typeof STORE_MODES)[number];
export const MODE_RULES: Record<StoreMode, { label: string; shipping: ShippingKind[]; tables: boolean; shipHours: number; pickupHours: number; graceHours: number; confirmHours: number; regret: boolean }> = {
  ecommerce: { label: 'E-commerce', shipping: ['pickup', 'local', 'fixed', 'carrier'], tables: false, shipHours: 72, pickupHours: 48, graceHours: 48, confirmHours: 7 * 24, regret: true },
  catalog: { label: 'Loja virtual', shipping: ['pickup', 'local'], tables: false, shipHours: 24, pickupHours: 24, graceHours: 24, confirmHours: 7 * 24, regret: true },
  menu: { label: 'Cardápio', shipping: ['pickup', 'local', 'table'], tables: true, shipHours: 2, pickupHours: 2, graceHours: 2, confirmHours: 24, regret: false },
  whatsapp: { label: 'Catálogo online', shipping: [], tables: false, shipHours: 0, pickupHours: 0, graceHours: 0, confirmHours: 0, regret: false },
};
/** Modos que dá para escolher agora. Loja virtual só para quem já usa. */
export const SELECTABLE_MODES: StoreMode[] = ['ecommerce', 'whatsapp', 'menu'];
/** Catálogo online não tem carrinho nem checkout: o cliente chama a loja no WhatsApp. */
export const hasCheckout = (m: StoreMode) => m !== 'whatsapp';
export const WHATSAPP_RE = /^\d{10,13}$/;

// ------------------------------------------------------------------ site da loja

/** Favicon: PNG, ICO ou WebP em data URL (até ~100 KB). */
/** Favicon: URL do arquivo no R2 (envio kind 'favicon') ou data URL de cliente antigo, que a API sobe para o R2. */
export const FAVICON_RE = /^(https?:\/\/[^\s"'<>]{1,400}|data:image\/(png|x-icon|vnd\.microsoft\.icon|webp);base64,[A-Za-z0-9+/=]+)$/;
/** Pagar na entrega ou na retirada (dinheiro, maquininha, Pix): cardápio e loja virtual, com entrega própria ou retirada. */
export const PAY_ON_DELIVERY = ['cash', 'card', 'pix'] as const;
export type PayOnDelivery = (typeof PAY_ON_DELIVERY)[number];
export const PAY_ON_DELIVERY_LABEL: Record<PayOnDelivery, string> = { cash: 'Dinheiro', card: 'Cartão na maquininha', pix: 'Pix' };

/** Lojas antigas (sem modo gravado): deduz pelo que já usam. */
export function modeOf(s: { mode?: StoreMode | null; tables?: { enabled?: boolean } | null; theme?: { layout?: string } | null }): StoreMode {
  if (s.mode && STORE_MODES.includes(s.mode)) return s.mode;
  return s.tables?.enabled || s.theme?.layout === 'menu' ? 'menu' : 'ecommerce';
}
export interface ShippingOption {
  id: string;
  kind: ShippingKind;
  name: string;
  priceCents: number;
  etaText: string;
  carrier?: string;
  free?: boolean;
}

export const inCepRanges = (cep: string, ranges: CepRange[] = []) =>
  ranges.some((r) => {
    const a = cleanCep(r.from), b = cleanCep(r.to);
    return !!a && !!b && cep >= (a < b ? a : b) && cep <= (a < b ? b : a);
  });

const days = (min: number, max: number) => (min === max ? `${min} dia${min === 1 ? '' : 's'} útei${min === 1 ? 'l' : 's'}` : `${min} a ${max} dias úteis`);
const freeIf = (subtotal: number, price: number, freeAbove?: number | null) => (freeAbove && freeAbove > 0 && subtotal >= freeAbove ? 0 : Math.max(0, price));

/** Opções que não dependem de transportadora (retirada, entrega local, frete fixo). */
export function baseShippingOptions(cfg: ShippingConfig, cep: string | null, subtotalCents: number): ShippingOption[] {
  const out: ShippingOption[] = [];
  if (cfg.pickup?.enabled) out.push({ id: 'pickup', kind: 'pickup', name: 'Retirar na loja', priceCents: 0, etaText: cfg.pickup.instructions?.trim() || 'Combine o horário com a loja', free: true });
  if (cep && cfg.local?.enabled && inCepRanges(cep, cfg.local.cepRanges)) {
    const price = freeIf(subtotalCents, cfg.local.priceCents ?? 0, cfg.local.freeAboveCents);
    out.push({ id: 'local', kind: 'local', name: cfg.local.name?.trim() || 'Entrega da loja', priceCents: price, etaText: cfg.local.etaText?.trim() || 'Combine com a loja', free: price === 0 });
  }
  if (cep && cfg.fixed?.enabled) {
    const price = freeIf(subtotalCents, cfg.fixed.priceCents ?? 0, cfg.fixed.freeAboveCents);
    const min = Math.max(1, cfg.fixed.minDays ?? 3), max = Math.max(min, cfg.fixed.maxDays ?? min);
    out.push({ id: 'fixed', kind: 'fixed', name: cfg.fixed.name?.trim() || 'Envio padrão', priceCents: price, etaText: days(min, max), free: price === 0 });
  }
  return out;
}

/** Cotação de transportadora (Melhor Envio) já ajustada com prazo de postagem, acréscimo e frete grátis. */
export function carrierOption(
  q: { id: number | string; name: string; company?: string; priceCents: number; minDays: number; maxDays: number },
  cfg: NonNullable<ShippingConfig['melhorEnvio']>,
  subtotalCents: number,
): ShippingOption {
  const h = Math.max(0, cfg.handlingDays ?? 1);
  const price = freeIf(subtotalCents, q.priceCents + Math.max(0, cfg.extraFeeCents ?? 0), cfg.freeAboveCents);
  return {
    id: `me:${q.id}`, kind: 'carrier', carrier: q.company,
    name: q.company && !q.name.toLowerCase().includes(q.company.toLowerCase()) ? `${q.company} ${q.name}` : q.name,
    priceCents: price, etaText: days(q.minDays + h, Math.max(q.minDays, q.maxDays) + h), free: price === 0,
  };
}

/** Pacote do pedido: soma o peso, empilha a altura e usa a maior largura/comprimento (estimativa conservadora). */
export interface Dims { weightGrams?: number | null; heightCm?: number | null; widthCm?: number | null; lengthCm?: number | null }
export const DEFAULT_PACKAGE = { weightGrams: 300, heightCm: 4, widthCm: 20, lengthCm: 25 };
export function itemDims(p: Dims, def: Dims = DEFAULT_PACKAGE) {
  const pick = (a: number | null | undefined, b: number | null | undefined, c: number) => (a && a > 0 ? a : b && b > 0 ? b : c);
  return {
    weightGrams: pick(p.weightGrams, def.weightGrams, DEFAULT_PACKAGE.weightGrams),
    heightCm: pick(p.heightCm, def.heightCm, DEFAULT_PACKAGE.heightCm),
    widthCm: pick(p.widthCm, def.widthCm, DEFAULT_PACKAGE.widthCm),
    lengthCm: pick(p.lengthCm, def.lengthCm, DEFAULT_PACKAGE.lengthCm),
  };
}

/** Caixa do pedido para a etiqueta: soma o peso, empilha a altura (até 100 cm) e usa a maior largura e comprimento. */
export function packageFor(lines: { dims: Dims; quantity: number }[], def: Dims = DEFAULT_PACKAGE) {
  let weightGrams = 0, heightCm = 0, widthCm = 0, lengthCm = 0;
  for (const l of lines) {
    const d = itemDims(l.dims, def);
    weightGrams += d.weightGrams * l.quantity; heightCm += d.heightCm * l.quantity;
    widthCm = Math.max(widthCm, d.widthCm); lengthCm = Math.max(lengthCm, d.lengthCm);
  }
  return { weightGrams: Math.max(10, weightGrams), heightCm: Math.min(100, Math.max(1, heightCm)), widthCm: Math.max(1, widthCm), lengthCm: Math.max(1, lengthCm) };
}

// ------------------------------------------------------------------ pedido

export const ORDER_STATUSES = ['pending_payment', 'confirmed', 'paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Aguardando pagamento', confirmed: 'Confirmado · paga na entrega', paid: 'Pago', preparing: 'Em preparação', ready_for_pickup: 'Pronto para retirada',
  shipped: 'Enviado', delivered: 'Entregue', cancelled: 'Cancelado', expired: 'Pagamento não concluído',
};

/** Para onde o lojista pode levar o pedido a partir de cada status (cancelamento à parte). */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: [],
  confirmed: ['preparing', 'ready_for_pickup', 'shipped', 'delivered'],
  paid: ['preparing', 'ready_for_pickup', 'shipped', 'delivered'],
  preparing: ['ready_for_pickup', 'shipped', 'delivered'],
  ready_for_pickup: ['delivered'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
  expired: [],
};
export function canMove(from: OrderStatus, to: OrderStatus, shippingKind: ShippingKind): boolean {
  if (!NEXT[from].includes(to)) return false;
  if (to === 'ready_for_pickup' && shippingKind !== 'pickup') return false;
  if (to === 'shipped' && (shippingKind === 'pickup' || shippingKind === 'table')) return false;
  return true;
}
export const canCancel = (s: OrderStatus) => ['pending_payment', 'confirmed', 'paid', 'preparing', 'ready_for_pickup', 'shipped'].includes(s);
export const isPaidLike = (s: OrderStatus) => ['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'].includes(s);

/** Link de rastreio dos Correios quando o código tem o formato padrão (AA123456789BR). */
export function trackingUrlFor(code: string): string | null {
  const c = code.trim().toUpperCase();
  return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(c) ? `https://rastreamento.correios.com.br/app/index.php?objeto=${c}` : null;
}

export const PAYMENT_WINDOW_MIN = 60;

/**
 * Preço na loja online que deixa para o lojista o mesmo que o preço do balcão, depois da taxa da loja online.
 * Ex.: R$ 100 com 3% → R$ 103,10 (103,10 − 3% = 100,01). Arredonda para cima, nunca deixa o lojista perder.
 */
export function priceWithOnlineFee(counterCents: number, rateBps: number): number {
  if (rateBps <= 0) return counterCents;
  return Math.ceil(counterCents / (1 - rateBps / 10_000));
}
