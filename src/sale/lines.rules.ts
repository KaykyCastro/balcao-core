import { priceChoice, type OptionChoice, type OptionGroup, type PickedOption } from '../products/options.rules';

/**
 * Linhas da venda no balcão com opções do produto (tamanho, cor, adicionais). O estoque e a promoção contam por
 * produto; o preço de cada linha é o preço base (promoção ou normal) + o adicional das opções escolhidas.
 */
export interface SaleLineIn { productId: string; quantity: number; options?: OptionChoice[] | null; note?: string | null }
export interface PricedLine { quantity: number; extraCents: number; picked: PickedOption[]; note: string }
export interface ProductLines { quantity: number; lines: PricedLine[] }

/**
 * Junta as linhas por produto e, dentro dele, pela mesma escolha + observação (escolhas iguais viram uma linha).
 * Confere as opções com as regras do produto; escolha inválida lança OptionsError.
 */
export function groupSaleLines(items: SaleLineIn[], productOf: (id: string) => { name: string; options?: OptionGroup[] | null }): Map<string, ProductLines> {
  const out = new Map<string, ProductLines>();
  const keys = new Map<string, PricedLine>();
  for (const it of items) {
    const p = productOf(it.productId);
    const { extraCents, picked, key } = priceChoice(p.options ?? [], it.options ?? [], p.name);
    const note = (it.note ?? '').trim().slice(0, 140);
    const k = `${it.productId}|${key}|${note}`;
    const g = out.get(it.productId) ?? { quantity: 0, lines: [] };
    g.quantity += it.quantity;
    const same = keys.get(k);
    if (same) same.quantity += it.quantity;
    else { const line = { quantity: it.quantity, extraCents, picked, note }; keys.set(k, line); g.lines.push(line); }
    out.set(it.productId, g);
  }
  return out;
}

/** Divide as unidades em promoção entre as linhas, na ordem: cada parte sai com o preço base dela + o adicional da linha. */
export function splitPromoUnits(lines: PricedLine[], promoQty: number, promoCents: number, normalCents: number) {
  const parts: { line: PricedLine; quantity: number; unitCents: number; promo: boolean }[] = [];
  let left = promoQty;
  for (const line of lines) {
    const pq = Math.min(left, line.quantity); left -= pq;
    if (pq > 0) parts.push({ line, quantity: pq, unitCents: promoCents + line.extraCents, promo: true });
    const rest = line.quantity - pq;
    if (rest > 0) parts.push({ line, quantity: rest, unitCents: normalCents + line.extraCents, promo: false });
  }
  return parts;
}
