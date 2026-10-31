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
export type ShippingKind = 'pickup' | 'local' | 'fixed' | 'carrier';
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

// ------------------------------------------------------------------ pedido

export const ORDER_STATUSES = ['pending_payment', 'paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Aguardando pagamento', paid: 'Pago', preparing: 'Em preparação', ready_for_pickup: 'Pronto para retirada',
  shipped: 'Enviado', delivered: 'Entregue', cancelled: 'Cancelado', expired: 'Pagamento não concluído',
};

/** Para onde o lojista pode levar o pedido a partir de cada status (cancelamento à parte). */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: [],
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
  if (to === 'shipped' && shippingKind === 'pickup') return false;
  return true;
}
export const canCancel = (s: OrderStatus) => ['pending_payment', 'paid', 'preparing', 'ready_for_pickup', 'shipped'].includes(s);
export const isPaidLike = (s: OrderStatus) => ['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'].includes(s);

/** Link de rastreio dos Correios quando o código tem o formato padrão (AA123456789BR). */
export function trackingUrlFor(code: string): string | null {
  const c = code.trim().toUpperCase();
  return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(c) ? `https://rastreamento.correios.com.br/app/index.php?objeto=${c}` : null;
}

export const PAYMENT_WINDOW_MIN = 60;
