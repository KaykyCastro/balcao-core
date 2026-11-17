/**
 * Trocas e devoluções no balcão: regras puras (sem banco). Spec em exchange.spec.ts.
 *
 * - O cliente traz o comprovante; o número impresso ("Nº 6E6770") são os 6 últimos caracteres do id da venda.
 * - Só dentro de EXCHANGE_DAYS (7) dias corridos depois da compra.
 * - O valor devolvido é o que o cliente PAGOU pelo item: preço da linha (já com promoção) menos a parte proporcional do
 *   desconto do carrinho. A taxa de serviço da mesa não entra (não é produto).
 * - Nunca devolve mais unidades do que as vendidas, somando as trocas anteriores da mesma venda.
 * - Acerto: o valor devolvido paga primeiro os produtos novos; faltando, o cliente paga a diferença; sobrando, abate o
 *   fiado em aberto (venda original no fiado) e o resto vira crédito na loja ou dinheiro de volta.
 */
export const EXCHANGE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Código do comprovante: os 6 últimos caracteres do id da venda, em maiúsculas. */
export const saleCode = (id: string) => String(id).slice(-6).toUpperCase();
/** O que o lojista digita: 6 caracteres hexadecimais (o código do comprovante) ou o id inteiro da venda. */
export function parseSaleCode(raw: string): { code: string } | { id: string } | null {
  const v = String(raw ?? '').replace(/^n[ºo°]?\s*/i, '').replace(/[\s#.-]/g, '').toLowerCase();
  if (/^[a-f0-9]{24}$/.test(v)) return { id: v };
  if (/^[a-f0-9]{6}$/.test(v)) return { code: v };
  return null;
}

export function deadlineOf(saleAt: Date) { return new Date(new Date(saleAt).getTime() + EXCHANGE_DAYS * DAY_MS); }
export const withinWindow = (saleAt: Date, now: Date) => now.getTime() <= deadlineOf(saleAt).getTime();

/**
 * Quanto o cliente pagou por cada linha: o desconto do carrinho é repartido proporcionalmente ao valor de cada linha,
 * pelo maior resto, para a soma bater exatamente com o que foi pago pelos produtos.
 */
export function paidByLine(lines: { totalCents: number }[], discountCents = 0): number[] {
  const sum = lines.reduce((a, l) => a + l.totalCents, 0);
  const off = Math.min(Math.max(0, discountCents || 0), sum);
  if (!sum || !off) return lines.map((l) => l.totalCents);
  const exact = lines.map((l) => (off * l.totalCents) / sum);
  const share = exact.map(Math.floor);
  let rest = off - share.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (rest <= 0) break; share[i] += 1; rest -= 1; }
  return lines.map((l, i) => l.totalCents - share[i]);
}

/**
 * Valor de devolver `qty` unidades de uma linha que custou `paidLine` por `lineQty` unidades, já tendo devolvido
 * `doneQty` unidades (valendo `doneCents`). Na última unidade da linha, devolve exatamente o que falta (sem centavo perdido).
 */
export function returnValue(paidLine: number, lineQty: number, doneQty: number, doneCents: number, qty: number): number {
  if (qty <= 0) return 0;
  if (doneQty + qty >= lineQty) return Math.max(0, paidLine - doneCents);
  return Math.round((paidLine * qty) / lineQty);
}

export type LeftoverMode = 'credit' | 'refund';
export interface Settlement {
  returnedCents: number; newCents: number;
  /** Parte dos produtos novos paga com o valor devolvido. */
  usedFromReturnCents: number;
  /** Diferença que o cliente ainda paga (forma de pagamento normal). */
  toPayCents: number;
  /** Sobra do valor devolvido, antes de abater o fiado. */
  leftoverCents: number;
  /** Sobra que abate o fiado em aberto do cliente (só quando a venda original foi no fiado). */
  debtAbatedCents: number;
  /** O que sobra depois do fiado: vira crédito na loja ou dinheiro de volta. */
  creditOrRefundCents: number;
}
export function settle(returnedCents: number, newCents: number, openDebtCents = 0): Settlement {
  const used = Math.min(returnedCents, newCents);
  const leftover = Math.max(0, returnedCents - newCents);
  const debt = Math.min(leftover, Math.max(0, openDebtCents));
  return { returnedCents, newCents, usedFromReturnCents: used, toPayCents: Math.max(0, newCents - returnedCents), leftoverCents: leftover, debtAbatedCents: debt, creditOrRefundCents: leftover - debt };
}

export class ExchangeError extends Error { constructor(public code: string, message: string) { super(message); } }

/**
 * Confere o pedido de devolução contra a venda: linha existe, quantidade ≥ 1, não passa do que ainda pode voltar.
 * Devolve o valor de cada devolução (na ordem pedida) e o total.
 */
export function priceReturns(
  sale: { items: { quantity: number; totalCents: number }[]; discountCents?: number },
  done: { line: number; quantity: number; totalCents: number }[],
  want: { line: number; quantity: number }[],
) {
  const paid = paidByLine(sale.items, sale.discountCents ?? 0);
  const doneQty = new Map<number, number>(), doneCents = new Map<number, number>();
  for (const d of done) { doneQty.set(d.line, (doneQty.get(d.line) ?? 0) + d.quantity); doneCents.set(d.line, (doneCents.get(d.line) ?? 0) + d.totalCents); }
  const seen = new Set<number>();
  const out = want.map((w) => {
    const it = sale.items[w.line];
    if (!it || !Number.isInteger(w.line)) throw new ExchangeError('EXCHANGE_LINE_INVALID', 'Esse item não está nessa venda.');
    if (seen.has(w.line)) throw new ExchangeError('EXCHANGE_LINE_INVALID', 'O mesmo item foi escolhido duas vezes.');
    seen.add(w.line);
    if (!Number.isInteger(w.quantity) || w.quantity < 1) throw new ExchangeError('EXCHANGE_QTY_INVALID', 'Quantidade inválida.');
    const dq = doneQty.get(w.line) ?? 0;
    if (dq + w.quantity > it.quantity) throw new ExchangeError('EXCHANGE_QTY_TOO_HIGH', `Desse item só ${Math.max(0, it.quantity - dq)} unidade(s) ainda pode(m) ser devolvida(s).`);
    return { line: w.line, quantity: w.quantity, totalCents: returnValue(paid[w.line], it.quantity, dq, doneCents.get(w.line) ?? 0, w.quantity) };
  });
  return { lines: out, returnedCents: out.reduce((a, l) => a + l.totalCents, 0), paid, doneQty };
}
