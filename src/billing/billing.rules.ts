import { TRIAL_DAYS } from './billing.constants';

const DAY = 24 * 3600_000;

export interface TrialInfo { createdAt?: Date; trialEndsAt?: Date | null }

/** Fim do teste grátis. Empresas antigas (sem o campo) usam cadastro + 30 dias. */
export function trialEnd(e: TrialInfo): Date {
  if (e.trialEndsAt) return e.trialEndsAt;
  return new Date((e.createdAt ?? new Date()).getTime() + TRIAL_DAYS * DAY);
}
export const inTrial = (e: TrialInfo, now: Date = new Date()): boolean => now < trialEnd(e);
export const trialDaysLeft = (e: TrialInfo, now: Date = new Date()): number => Math.max(0, Math.ceil((trialEnd(e).getTime() - now.getTime()) / DAY));

/** Vencimento de uma fatura emitida agora. */
export const dueDateFrom = (now: Date, days: number): Date => new Date(now.getTime() + days * DAY);

/** Quem não paga taxa: admin, isenta pelo admin ou ainda no teste grátis. */
export function feeWaived(e: TrialInfo & { role?: string; feeExempt?: boolean }, now: Date = new Date()): 'admin' | 'exempt' | 'trial' | null {
  if (e.role === 'admin') return 'admin';
  if (e.feeExempt) return 'exempt';
  if (inTrial(e, now)) return 'trial';
  return null;
}

/** Mês ('YYYY-MM') válido para mês grátis: formato certo e no máximo 12 meses para a frente. */
export function freeMonthProblem(period: string, now = new Date()): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return 'Mês inválido (use AAAA-MM)';
  const [y, m] = period.split('-').map(Number);
  const months = (y - now.getUTCFullYear()) * 12 + (m - 1 - now.getUTCMonth());
  if (months > 12) return 'Escolha um mês até 12 meses à frente';
  if (months < -24) return 'Esse mês é antigo demais';
  return null;
}
/** Este mês está liberado de taxa para a empresa? */
export const isFreeMonth = (e: { freeMonths?: string[] | null }, period: string) => !!e.freeMonths?.includes(period);
