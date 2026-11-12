/**
 * Layout da tela de vendas e do comprovante, escolhido pelo dono em Configurações e usado por todos:
 * web, app e colaboradores. Aqui é só a lista do que pode ser guardado (tipos, limites, tamanhos);
 * cada cliente completa o que faltar com os próprios padrões.
 * Os ajustes da impressora (colunas, cópias, corte…) não entram: cada aparelho tem a sua.
 * Campo desconhecido ou valor inválido é descartado em silêncio (um cliente antigo não quebra a gravação).
 */
export type PdvLayoutData = Record<string, unknown>;

const HEX = /^#[0-9a-f]{6}$/i;
const CTRL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const oneOf = <T>(ok: readonly T[]) => (v: unknown) => (ok.includes(v as T) ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const hex = (v: unknown) => (typeof v === 'string' && HEX.test(v) ? v : undefined);
const text = (max: number) => (v: unknown) => (typeof v === 'string' ? v.replace(CTRL, '').slice(0, max) : undefined);
const lines = (n: number, len: number) => (v: unknown) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').split('\n').slice(0, n).map((x) => x.slice(0, len)).join('\n') : undefined;
const int = (min: number, max: number) => (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

const LAYOUT: Record<string, (v: unknown) => unknown> = {
  template: text(20),
  bg: hex,
  shape: oneOf(['rounded', 'square', 'pill']),
  products: oneOf(['grid', 'big', 'list']),
  showCode: bool, showStock: bool, showLogo: bool,
  subtitle: text(40),
  popularLimit: int(1, 48),
  accent: (v) => (v === null ? null : hex(v)),
  pageBg: (v) => (v === null ? null : hex(v)),
  cartSide: oneOf(['right', 'left']),
  density: oneOf(['comfortable', 'compact']),
  textSize: oneOf(['sm', 'md', 'lg']),
  header: oneOf(['full', 'minimal', 'hidden']),
  columns: oneOf([2, 3, 4]),
  showPhotos: bool, showFilters: bool, showHistory: bool, quickCash: bool, allowDiscount: bool, confirmFinish: bool,
  discountPresets: (v) => (Array.isArray(v) ? [...new Set(v.filter((n) => Number.isInteger(n) && n >= 1 && n <= 90) as number[])].sort((a, b) => a - b).slice(0, 4) : undefined),
};

const RECEIPT: Record<string, (v: unknown) => unknown> = {
  paper: oneOf(['80mm', 'a4']),
  showLogo: bool, showCnpj: bool, showCustomer: bool, showCode: bool, showSaleNo: bool, showDate: bool, showPayment: bool,
  footer: lines(2, 80), header: lines(4, 48),
  // Colunas, codificação, cópias, corte, avanço e impressão automática dependem da impressora: ficam em cada aparelho.
};

function pick(raw: Record<string, unknown>, spec: Record<string, (v: unknown) => unknown>): PdvLayoutData {
  const out: PdvLayoutData = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (!(k in raw)) continue;
    const v = fn(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Logo: data URL de imagem (o serviço sobe para o armazenamento), https ou null. */
export const LOGO_RE = /^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s"'<>]+)$/i;
export const LOGO_MAX = 450_000;

export function sanitizePdvLayout(raw: unknown): PdvLayoutData {
  if (!isObj(raw)) return {};
  const out = pick(raw, LAYOUT);
  if ('logo' in raw) {
    const l = raw.logo;
    if (l === null || l === '') out.logo = null;
    else if (typeof l === 'string' && l.length <= LOGO_MAX && LOGO_RE.test(l)) out.logo = l;
  }
  if (isObj(raw.receipt)) out.receipt = pick(raw.receipt, RECEIPT);
  return out;
}
