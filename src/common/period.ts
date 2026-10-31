/** Fuso usado para fechar o mês de cobrança. */
export const BILLING_TZ = 'America/Fortaleza';

/** Início do mês seguinte a `date` no fuso de cobrança (Fortaleza = UTC-3, sem horário de verão). */
export function nextMonthStart(date: Date = new Date()): Date {
  const [y, m] = periodOf(date).split('-').map(Number);
  return new Date(Date.UTC(y, m, 1, 3, 0, 0)); // m já é o mês seguinte (0-based)
}

/** Retorna 'YYYY-MM' da data no fuso de cobrança. */
export function periodOf(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BILLING_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  return `${year}-${month}`;
}
