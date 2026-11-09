/** Regras puras da cobrança automática da fatura (autopay.service.ts). */

/** Dia do mês da cobrança no cartão: depois de a fatura sair (dia 1) e bem antes de vencer (15 dias). */
export const CHARGE_DAY = 3;

/** Próxima data de cobrança: dia 3, ao meio-dia de Brasília (15:00 UTC), sempre no futuro. */
export function nextChargeDate(now: Date): Date {
  const at = (y: number, m: number) => new Date(Date.UTC(y, m, CHARGE_DAY, 15, 0, 0));
  const here = at(now.getUTCFullYear(), now.getUTCMonth());
  return here.getTime() > now.getTime() + 3_600_000 ? here : at(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/** Valor do próximo ciclo: o que está em aberto e ainda não venceu (vencida já bloqueou: paga-se pelo link). */
export const autopayAmount = (pending: { amountCents: number }[]) => pending.reduce((n, i) => n + i.amountCents, 0);
