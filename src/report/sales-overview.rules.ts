/**
 * Resumo da página "Gestão de vendas" para um período: balcão (por forma), online, cancelamentos, trocas e
 * correções de pagamento, mais a série por dia (Brasília). Só soma; quem busca os dados é o serviço.
 */
export interface OvSale {
  channel?: 'pos' | 'online'; status: 'completed' | 'cancelled'; paymentMethod: string; totalCents: number;
  creditCents?: number; exchangeCents?: number; discountCents?: number; createdAt?: Date; paymentEdits?: unknown[] | null;
}
export interface OvExchange { returnedCents: number; newCents: number; creditCents: number; refundCents: number; createdAt?: Date }

export const OV_METHODS = ['cash', 'pix', 'card', 'other', 'fiado'] as const;
const DAY_MS = 86_400_000;
/** Dia de Brasília (AAAA-MM-DD) de um instante. */
export const brDay = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);

export function salesOverview(sales: OvSale[], exchanges: OvExchange[], from: string, to: string) {
  const pos = { count: 0, totalCents: 0, discountCents: 0, coveredCents: 0, byMethod: Object.fromEntries(OV_METHODS.map((m) => [m, 0])) as Record<string, number> };
  const online = { count: 0, totalCents: 0 };
  const cancelled = { count: 0, totalCents: 0 };
  let edited = 0;
  // Série por dia: todos os dias do período, mesmo sem venda (no máximo 92).
  const days = new Map<string, { day: string; posCents: number; onlineCents: number }>();
  const start = new Date(`${from}T12:00:00Z`).getTime(), end = new Date(`${to}T12:00:00Z`).getTime();
  for (let t = start; t <= end && days.size < 92; t += DAY_MS) { const d = new Date(t).toISOString().slice(0, 10); days.set(d, { day: d, posCents: 0, onlineCents: 0 }); }

  for (const s of sales) {
    if (s.paymentEdits?.length) edited++;
    if (s.status === 'cancelled') { cancelled.count++; cancelled.totalCents += s.totalCents; continue; }
    const day = s.createdAt ? days.get(brDay(new Date(s.createdAt))) : undefined;
    if (s.channel === 'online') {
      online.count++; online.totalCents += s.totalCents;
      if (day) day.onlineCents += s.totalCents;
      continue;
    }
    pos.count++; pos.totalCents += s.totalCents; pos.discountCents += s.discountCents ?? 0;
    const covered = Math.min(s.totalCents, (s.creditCents ?? 0) + (s.exchangeCents ?? 0));
    pos.coveredCents += covered;
    if (s.paymentMethod in pos.byMethod) pos.byMethod[s.paymentMethod] += s.totalCents - covered;
    if (day) day.posCents += s.totalCents;
  }
  const ex = { count: 0, returnedCents: 0, newCents: 0, creditCents: 0, refundCents: 0 };
  for (const x of exchanges) { ex.count++; ex.returnedCents += x.returnedCents; ex.newCents += x.newCents; ex.creditCents += x.creditCents; ex.refundCents += x.refundCents; }
  const totalCents = pos.totalCents + online.totalCents;
  const count = pos.count + online.count;
  return { from, to, totalCents, count, avgTicketCents: count ? Math.round(totalCents / count) : 0, pos, online, cancelled, exchanges: ex, editedCount: edited, days: [...days.values()] };
}
