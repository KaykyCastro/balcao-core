import { randomBytes } from 'crypto';

/**
 * Adicionais do produto (cardápio): grupos de opções que o cliente escolhe ao pedir. Ex.: "Escolha até 3 queijos"
 * (mín. 1, máx. 3), "Borda" (mín. 0, máx. 1, Catupiry +R$ 8,00), "Ponto da carne" (mín. 1, máx. 1, sem custo).
 * Puro (sem banco): validação no cadastro e preço da escolha no checkout. O preço vem SEMPRE daqui, nunca do cliente.
 *
 * Cobrança do grupo (`pricing`):
 * - `sum`: soma o preço de cada opção escolhida (× quantidade). Padrão: borda, adicionais, bebidas.
 * - `max`: cobra a opção mais cara escolhida. Pizza de vários sabores: paga o sabor mais caro.
 * - `avg`: cobra a média das escolhidas (arredondada para cima). Pizza meio a meio pela média.
 */
export const OPTION_PRICING = ['sum', 'max', 'avg'] as const;
export type OptionPricing = (typeof OPTION_PRICING)[number];

export interface OptionItem { id: string; name: string; description: string; priceCents: number; available: boolean }
export interface OptionGroup { id: string; name: string; min: number; max: number; repeat: boolean; pricing: OptionPricing; items: OptionItem[] }
/** O que o cliente escolheu: grupo, opção e quantas vezes (só > 1 em grupo com `repeat`). */
export interface OptionChoice { g: string; i: string; q: number }
/** Opção como fica gravada no pedido/venda (texto, para o histórico não mudar se o lojista editar o produto). */
export interface PickedOption { group: string; name: string; qty: number; priceCents: number }

export const OPTION_LIMITS = { groups: 12, items: 40, name: 60, description: 120, priceCents: 1_000_000, repeatMax: 20 } as const;

export class OptionsError extends Error {}

const ID_RE = /^[a-z0-9]{1,16}$/i;
const newId = () => randomBytes(5).toString('hex');
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : NaN);

/** Valida e normaliza os grupos que o lojista salvou. Erro com mensagem pronta para a tela. */
export function sanitizeOptions(raw: unknown): OptionGroup[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new OptionsError('Adicionais inválidos');
  if (raw.length > OPTION_LIMITS.groups) throw new OptionsError(`Até ${OPTION_LIMITS.groups} grupos de adicionais por produto`);
  const gids = new Set<string>();
  return raw.map((g: Record<string, unknown>, gi) => {
    if (!g || typeof g !== 'object') throw new OptionsError('Adicionais inválidos');
    const name = text(g.name, OPTION_LIMITS.name);
    if (!name) throw new OptionsError(`Dê um nome ao grupo ${gi + 1} de adicionais (ex.: "Escolha os queijos")`);
    const itemsRaw = Array.isArray(g.items) ? g.items : [];
    if (!itemsRaw.length) throw new OptionsError(`O grupo "${name}" precisa de pelo menos uma opção`);
    if (itemsRaw.length > OPTION_LIMITS.items) throw new OptionsError(`O grupo "${name}" passa de ${OPTION_LIMITS.items} opções`);
    const iids = new Set<string>();
    const items: OptionItem[] = itemsRaw.map((it: Record<string, unknown>) => {
      const iname = text(it?.name, OPTION_LIMITS.name);
      if (!iname) throw new OptionsError(`Há uma opção sem nome em "${name}"`);
      const price = it?.priceCents == null ? 0 : int(it.priceCents);
      if (!(price >= 0 && price <= OPTION_LIMITS.priceCents)) throw new OptionsError(`Preço inválido em "${iname}"`);
      let id = typeof it?.id === 'string' && ID_RE.test(it.id) ? it.id : newId();
      if (iids.has(id)) id = newId();
      iids.add(id);
      return { id, name: iname, description: text(it?.description, OPTION_LIMITS.description), priceCents: price, available: it?.available !== false };
    });
    const repeat = g.repeat === true;
    const cap = repeat ? OPTION_LIMITS.repeatMax : items.length;
    const max = g.max == null ? 1 : int(g.max);
    const min = g.min == null ? 0 : int(g.min);
    if (!(max >= 1 && max <= cap)) throw new OptionsError(`"${name}": o máximo vai de 1 a ${cap}`);
    if (!(min >= 0 && min <= max)) throw new OptionsError(`"${name}": o mínimo vai de 0 até o máximo (${max})`);
    const pricing = OPTION_PRICING.includes(g.pricing as OptionPricing) ? (g.pricing as OptionPricing) : 'sum';
    let id = typeof g.id === 'string' && ID_RE.test(g.id) ? g.id : newId();
    if (gids.has(id)) id = newId();
    gids.add(id);
    return { id, name, min, max, repeat, pricing, items };
  });
}

/**
 * Confere a escolha do cliente contra os grupos do produto e devolve o valor a somar ao preço unitário, as opções
 * para gravar no pedido e uma chave estável (mesma escolha = mesma linha do carrinho).
 */
export function priceChoice(groups: OptionGroup[] | null | undefined, chosen: OptionChoice[] | null | undefined, productName = 'o produto'): { extraCents: number; picked: PickedOption[]; key: string } {
  const gs = groups ?? [];
  const list = chosen ?? [];
  if (list.length > 200) throw new OptionsError('Escolhas demais');
  const byGroup = new Map<string, Map<string, number>>();
  for (const c of list) {
    const g = gs.find((x) => x.id === c?.g);
    if (!g) throw new OptionsError(`Os adicionais de ${productName} mudaram. Escolha de novo.`);
    const it = g.items.find((x) => x.id === c.i);
    if (!it) throw new OptionsError(`Os adicionais de ${productName} mudaram. Escolha de novo.`);
    if (!it.available) throw new OptionsError(`"${it.name}" acabou. Escolha outra opção em "${g.name}".`);
    const q = int(c.q);
    if (!(q >= 1 && q <= OPTION_LIMITS.repeatMax)) throw new OptionsError('Quantidade de adicional inválida');
    const m = byGroup.get(g.id) ?? new Map<string, number>();
    if (m.has(it.id) && !g.repeat) throw new OptionsError(`"${it.name}" foi escolhido duas vezes`);
    if (q > 1 && !g.repeat) throw new OptionsError(`Em "${g.name}" cada opção vale uma vez`);
    m.set(it.id, (m.get(it.id) ?? 0) + q);
    byGroup.set(g.id, m);
  }
  let extraCents = 0;
  const picked: PickedOption[] = [];
  const keyParts: string[] = [];
  for (const g of gs) {
    const m = byGroup.get(g.id) ?? new Map<string, number>();
    const total = [...m.values()].reduce((s, q) => s + q, 0);
    if (total < g.min) throw new OptionsError(g.min === 1 ? `Escolha uma opção em "${g.name}"` : `Escolha pelo menos ${g.min} em "${g.name}"`);
    if (total > g.max) throw new OptionsError(g.max === 1 ? `Escolha só uma opção em "${g.name}"` : `Escolha até ${g.max} em "${g.name}"`);
    if (!total) continue;
    const rows = g.items.filter((it) => m.has(it.id)).map((it) => ({ it, q: m.get(it.id)! }));
    const units = rows.map((r) => r.it.priceCents);
    const charge = g.pricing === 'max' ? Math.max(...units)
      : g.pricing === 'avg' ? Math.ceil(rows.reduce((s, r) => s + r.it.priceCents * r.q, 0) / total)
      : rows.reduce((s, r) => s + r.it.priceCents * r.q, 0);
    extraCents += charge;
    for (const r of rows) {
      // Em "sum" cada opção mostra o próprio preço; em "max"/"avg" o grupo cobra um valor só (fica na primeira linha).
      picked.push({ group: g.name, name: r.it.name, qty: r.q, priceCents: g.pricing === 'sum' ? r.it.priceCents : 0 });
      keyParts.push(`${g.id}:${r.it.id}:${r.q}`);
    }
    if (g.pricing !== 'sum' && charge > 0) picked[picked.length - rows.length].priceCents = charge;
  }
  return { extraCents, picked, key: keyParts.join(',') };
}

/** Menor valor a somar ao preço (o "a partir de" da vitrine): os mínimos obrigatórios pelas opções mais baratas. */
export function minExtraCents(groups: OptionGroup[] | null | undefined): number {
  let s = 0;
  for (const g of groups ?? []) {
    if (!g.min) continue;
    const prices = g.items.filter((i) => i.available).map((i) => i.priceCents).sort((a, b) => a - b);
    if (!prices.length) continue;
    if (g.pricing === 'max' || g.pricing === 'avg') s += prices[0];
    else s += g.repeat ? prices[0] * g.min : prices.slice(0, g.min).reduce((a, b) => a + b, 0);
  }
  return s;
}

/** Texto da linha para e-mail, comprovante e Mercado Pago: "Pizza grande (Queijos: Mussarela, Provolone · Borda: Catupiry)". */
export function lineName(name: string, picked?: PickedOption[] | null, note?: string | null): string {
  const groups = new Map<string, string[]>();
  for (const p of picked ?? []) groups.set(p.group, [...(groups.get(p.group) ?? []), p.qty > 1 ? `${p.qty}x ${p.name}` : p.name]);
  const opts = [...groups].map(([g, n]) => `${g}: ${n.join(', ')}`).join(' · ');
  const extra = [opts, note ? `Obs.: ${note}` : ''].filter(Boolean).join(' · ');
  return extra ? `${name} (${extra})` : name;
}
