import { intEnv } from '../common/config/env';

/** Taxa do ERP: 0,5% de cada venda (em basis points). */
export const FEE_RATE_BPS = 50;
/** Teto padrão da taxa por mês (R$ 40,00). O valor em uso vem de SettingsService (admin) ou do teto da empresa. */
export const DEBT_CAP_CENTS = 4000;
/** Teste grátis das contas antigas, que não têm `trialEndsAt` gravado (cadastro + 30 dias). Novos cadastros usam a política do admin. */
export const TRIAL_DAYS = 30;
/** Prazo para pagar uma fatura: 15 dias. Vencida e não paga => conta bloqueada. */
export const DEFAULT_GRACE_DAYS = 15;
export const graceDays = (env: string | undefined = process.env.BILLING_GRACE_DAYS) => intEnv(env, DEFAULT_GRACE_DAYS, 1, 60);

/** Taxa em centavos, arredondando meio-centavo para cima (aritmética inteira, sem float). */
export const calcFeeCents = (saleTotalCents: number): number =>
  Math.floor((saleTotalCents * FEE_RATE_BPS + 5000) / 10000);
