import { calcFeeCents } from './billing.constants';

/**
 * Teto mensal por faixa de faturamento (Termos de Uso, seção "Taxa por venda e faixas de faturamento").
 * A taxa é 0,5% de cada venda do balcão, somada no mês, até o teto da faixa em que o total vendido do mês estiver.
 * Recalcula todo mês: vendeu R$ 20 mil → até R$ 40; vendeu R$ 50 mil → até R$ 100; voltou a R$ 20 mil → R$ 40.
 *
 * ESPELHO de balcao-web/src/config/terms.ts (FEE_TIERS): mudar uma tabela exige mudar a outra E os Termos (aviso prévio).
 */
export interface FeeTier { upToCents: number | null; capCents: number }
export const FEE_TIERS: readonly FeeTier[] = [
  { upToCents: 2_000_000, capCents: 4_000 },    // até R$ 20 mil  → teto R$ 40
  { upToCents: 5_000_000, capCents: 10_000 },   // até R$ 50 mil  → teto R$ 100
  { upToCents: 10_000_000, capCents: 20_000 },  // até R$ 100 mil → teto R$ 200
  { upToCents: 20_000_000, capCents: 35_000 },  // até R$ 200 mil → teto R$ 350
  { upToCents: null, capCents: 50_000 },        // acima          → teto R$ 500
];

/** Primeiro mês ('AAAA-MM') cobrado por faixas. Antes dele valia o teto fixo. Env BILLING_TIERS_FROM. */
export const DEFAULT_TIERS_FROM = '2026-12';
export const tiersFrom = (env?: string | null) => (env && /^\d{4}-\d{2}$/.test(env) ? env : DEFAULT_TIERS_FROM);

/** Faixa (índice) e teto para o total vendido no mês. */
export function tierFor(monthBaseCents: number): { index: number; capCents: number; upToCents: number | null } {
  const i = FEE_TIERS.findIndex((t) => t.upToCents === null || monthBaseCents <= t.upToCents);
  const t = FEE_TIERS[i];
  return { index: i, capCents: t.capCents, upToCents: t.upToCents };
}

/**
 * Teto do mês. `negotiated` = teto próprio da empresa (o admin pode negociar): vale no lugar das faixas.
 * `fixed` = meses antes das faixas (teto fixo da plataforma).
 */
export function monthCapCents(monthBaseCents: number, o: { negotiated?: number | null; fixed?: number | null }): number {
  if (o.negotiated != null) return o.negotiated;
  if (o.fixed != null) return o.fixed;
  return tierFor(monthBaseCents).capCents;
}

/** Taxa devida no mês: a soma dos 0,5% de cada venda, limitada ao teto. */
export const monthFeeDue = (rawCents: number, capCents: number) => Math.max(0, Math.min(rawCents, capCents));

/**
 * Taxa desta venda: o que falta para a taxa devida do mês (com esta venda) chegar ao que já foi cobrado.
 * Ao passar para a faixa seguinte, a diferença entra nesta venda (é o que os Termos dizem: o mês paga o teto da
 * faixa em que fechar). Nunca negativa: cancelamentos são acertados no fechamento.
 */
export function feeForSale(month: { rawCents: number; baseCents: number; chargedCents: number }, saleCents: number, cap: (baseCents: number) => number) {
  const rawCents = calcFeeCents(saleCents);
  const base = month.baseCents + saleCents;
  const due = monthFeeDue(month.rawCents + rawCents, cap(base));
  return { rawCents, feeCents: Math.max(0, due - month.chargedCents) };
}

/**
 * Acerto do fechamento: devido no mês × já cobrado. Positivo = cobrar a diferença; negativo = devolver, mas só até
 * o que ainda não foi faturado (o que já virou fatura não é descontado aqui).
 */
export function settleMonth(month: { rawCents: number; baseCents: number; chargedCents: number; unbilledCents: number }, cap: (baseCents: number) => number) {
  const due = monthFeeDue(month.rawCents, cap(month.baseCents));
  const diff = due - month.chargedCents;
  return { dueCents: due, adjustCents: diff >= 0 ? diff : -Math.min(-diff, Math.max(0, month.unbilledCents)) };
}
