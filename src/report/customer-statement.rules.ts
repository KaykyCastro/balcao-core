/**
 * Extrato do cliente: a "conta" do fiado como um extrato bancário. Cada linha soma (compra no pagamento posterior)
 * ou abate (pagamento recebido, compra cancelada, sobra de troca), com o saldo depois dela.
 *
 * O saldo final sempre bate com a dívida real do cadastro (`debitCents`): quando a soma das linhas não chega nela
 * (dívida trazida de outro sistema, ajustes antigos), entra uma linha "Saldo anterior" no começo com a diferença.
 */
export type LedgerKind = 'opening' | 'sale' | 'cancel' | 'payment' | 'exchange';

export interface LedgerEvent {
  at: Date;
  kind: Exclude<LedgerKind, 'opening'>;
  /** + aumenta a dívida, − abate. */
  amountCents: number;
  /** Venda, pagamento ou troca de origem. */
  ref: string;
  /** Texto curto: itens da venda, forma do pagamento… */
  detail: string;
}

export interface LedgerLine { at: string | null; kind: LedgerKind; ref: string; detail: string; debitCents: number; creditCents: number; balanceCents: number }

const ORDER: Record<LedgerKind, number> = { opening: 0, sale: 1, cancel: 2, exchange: 3, payment: 4 };

/**
 * `from`/`to` = instantes (início do primeiro dia, início do dia seguinte ao último). Sem eles, o extrato é completo.
 * Devolve o saldo no começo do período, as linhas do período com saldo corrido e os totais do período.
 */
export function buildLedger(events: LedgerEvent[], currentDebtCents: number, range: { from?: Date | null; to?: Date | null } = {}) {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime() || ORDER[a.kind] - ORDER[b.kind]);
  const sum = sorted.reduce((n, e) => n + e.amountCents, 0);
  // Diferença entre a dívida real e a soma do histórico: entra como saldo anterior, antes de tudo.
  const adjust = currentDebtCents - sum;
  const lines: (LedgerLine & { t: number })[] = [];
  let balance = 0;
  if (adjust !== 0) {
    balance = adjust;
    const first = sorted[0]?.at ?? null;
    lines.push({ t: first ? first.getTime() - 1 : 0, at: null, kind: 'opening', ref: '', detail: 'Saldo anterior (dívida trazida de antes ou ajuste)', debitCents: Math.max(0, adjust), creditCents: Math.max(0, -adjust), balanceCents: balance });
  }
  for (const e of sorted) {
    balance += e.amountCents;
    lines.push({ t: e.at.getTime(), at: e.at.toISOString(), kind: e.kind, ref: e.ref, detail: e.detail, debitCents: Math.max(0, e.amountCents), creditCents: Math.max(0, -e.amountCents), balanceCents: balance });
  }
  const from = range.from?.getTime() ?? -Infinity, to = range.to?.getTime() ?? Infinity;
  const before = lines.filter((l) => l.t < from);
  const inside = lines.filter((l) => l.t >= from && l.t < to);
  const openingCents = before.length ? before[before.length - 1].balanceCents : 0;
  const closingCents = inside.length ? inside[inside.length - 1].balanceCents : openingCents;
  const total = (k: LedgerKind[], f: 'debitCents' | 'creditCents') => inside.filter((l) => k.includes(l.kind)).reduce((n, l) => n + l[f], 0);
  return {
    openingCents, closingCents,
    lines: inside.map(({ t: _t, ...l }) => l),
    totals: {
      boughtCents: total(['sale'], 'debitCents'),
      paidCents: total(['payment'], 'creditCents'),
      cancelledCents: total(['cancel'], 'creditCents'),
      exchangeCents: total(['exchange'], 'creditCents'),
      openingAdjustCents: inside.some((l) => l.kind === 'opening') ? adjust : 0,
    },
  };
}

/** O que a venda cobrou agora (fora crédito da loja e troca): é o que vai para o fiado. */
export const dueOf = (s: { totalCents: number; creditCents?: number; exchangeCents?: number }) => Math.max(0, s.totalCents - (s.creditCents ?? 0) - (s.exchangeCents ?? 0));

/** Resumo de uma venda para uma linha: "2× Vestido, 1× Cinto". */
export function itemsText(items: { productName: string; quantity: number }[], max = 3): string {
  const parts = items.slice(0, max).map((i) => `${i.quantity}× ${i.productName}`);
  return parts.join(', ') + (items.length > max ? ` e mais ${items.length - max}` : '');
}
