import { BadRequestException } from '@nestjs/common';

/**
 * Fechamento de caixa: o resumo de um dia (vendas, formas de pagamento, fiado recebido, dinheiro esperado na gaveta)
 * e a conferência (dinheiro contado − esperado). Regras puras, sem banco.
 *
 * O dia vai da meia-noite à meia-noite no horário de Brasília (UTC−3, sem horário de verão).
 */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_H = 3;

/** 'AAAA-MM-DD' de hoje (ou da data dada) no horário de Brasília. */
export function dayOf(now: Date = new Date()): string {
  return new Date(now.getTime() - OFFSET_H * 3600_000).toISOString().slice(0, 10);
}

/** Início e fim (exclusivo) do dia em UTC. Recusa data inválida, futura ou com mais de 2 anos. */
export function dayRange(day: string, now: Date = new Date()): { from: Date; to: Date } {
  if (!DAY_RE.test(day)) throw new BadRequestException({ code: 'DAY_INVALID', message: 'Data inválida (use AAAA-MM-DD).' });
  const [y, m, d] = day.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, d, OFFSET_H));
  if (from.getUTCDate() !== d || from.getUTCMonth() !== m - 1) throw new BadRequestException({ code: 'DAY_INVALID', message: 'Data inválida.' });
  if (day > dayOf(now)) throw new BadRequestException({ code: 'DAY_FUTURE', message: 'Esse dia ainda não chegou.' });
  if (now.getTime() - from.getTime() > 2 * 366 * 24 * 3600_000) throw new BadRequestException({ code: 'DAY_TOO_OLD', message: 'Escolha um dia dos últimos 2 anos.' });
  return { from, to: new Date(from.getTime() + 24 * 3600_000) };
}

/** Formas que entram no caixa da loja. 'online' (pago pelo site, cai no Mercado Pago) e 'fiado' ficam à parte. */
export const DRAWER_METHODS = ['cash', 'pix', 'card', 'other'] as const;
export type DrawerMethod = (typeof DRAWER_METHODS)[number];

export interface DaySale {
  paymentMethod: string; status: 'completed' | 'cancelled'; totalCents: number; discountCents?: number;
  /** Parte paga com crédito da loja / com o valor de uma troca: não é dinheiro que entrou no caixa. */
  creditCents?: number; exchangeCents?: number;
  createdAt: Date; staff?: { name?: string } | null; items?: { productName: string; quantity: number; totalCents: number }[];
}
export interface DayPayment { method: string; amountCents: number }
/** Troca do dia: o que voltou em dinheiro (sai do caixa), o crédito dado e o valor devolvido. */
export interface DayExchange { returnedCents: number; refundCents: number; refundMethod: string | null; creditCents: number }

/** Dinheiro que de fato entrou por esta venda (o total menos crédito da loja e valor de troca). */
export const receivedOf = (s: Pick<DaySale, 'totalCents' | 'creditCents' | 'exchangeCents'>) => Math.max(0, s.totalCents - (s.creditCents ?? 0) - (s.exchangeCents ?? 0));

const zero = (): Record<DrawerMethod, number> => ({ cash: 0, pix: 0, card: 0, other: 0 });
const isDrawer = (m: string): m is DrawerMethod => (DRAWER_METHODS as readonly string[]).includes(m);

/** Retirada de dinheiro da gaveta (sangria), autorizada com a senha do dono. */
export interface DayWithdrawal { amountCents: number }

export function daySummary(day: string, sales: DaySale[], payments: DayPayment[], openingCents = 0, exchanges: DayExchange[] = [], withdrawals: DayWithdrawal[] = []) {
  const done = sales.filter((s) => s.status === 'completed');
  const cancelled = sales.filter((s) => s.status === 'cancelled');
  const revenue = done.reduce((a, s) => a + s.totalCents, 0);

  const salesBy = zero(); const salesCount = zero();
  let online = 0, onlineCount = 0, fiado = 0, fiadoCount = 0;
  for (const s of done) {
    if (isDrawer(s.paymentMethod)) { salesBy[s.paymentMethod] += receivedOf(s); salesCount[s.paymentMethod] += 1; }
    else if (s.paymentMethod === 'online') { online += s.totalCents; onlineCount += 1; }
    else if (s.paymentMethod === 'fiado') { fiado += s.totalCents; fiadoCount += 1; }
  }
  const receivedBy = zero();
  for (const p of payments) if (isDrawer(p.method)) receivedBy[p.method] += p.amountCents;

  // Devoluções em dinheiro/Pix/cartão (trocas): saem do caixa daquela forma.
  const refundBy = zero();
  for (const x of exchanges) if (x.refundCents > 0) refundBy[isDrawer(x.refundMethod ?? '') ? (x.refundMethod as DrawerMethod) : 'other'] += x.refundCents;
  const drawer = DRAWER_METHODS.map((m) => ({ method: m, salesCents: salesBy[m], salesCount: salesCount[m], fiadoCents: receivedBy[m], refundCents: refundBy[m], totalCents: salesBy[m] + receivedBy[m] - refundBy[m] }));
  const drawerTotal = drawer.reduce((a, x) => a + x.totalCents, 0);
  const withdrawn = withdrawals.reduce((a, w) => a + Math.max(0, w.amountCents), 0);

  const staff = new Map<string, { count: number; totalCents: number }>();
  const hours = new Map<number, { count: number; totalCents: number }>();
  const products = new Map<string, { quantity: number; totalCents: number }>();
  for (const s of done) {
    const who = s.staff?.name || 'Dono';
    const st = staff.get(who) ?? { count: 0, totalCents: 0 }; st.count += 1; st.totalCents += s.totalCents; staff.set(who, st);
    const h = (new Date(s.createdAt).getUTCHours() + 24 - OFFSET_H) % 24;
    const hr = hours.get(h) ?? { count: 0, totalCents: 0 }; hr.count += 1; hr.totalCents += s.totalCents; hours.set(h, hr);
    for (const it of s.items ?? []) {
      const p = products.get(it.productName) ?? { quantity: 0, totalCents: 0 }; p.quantity += it.quantity; p.totalCents += it.totalCents; products.set(it.productName, p);
    }
  }

  return {
    day,
    sales: {
      count: done.length, revenueCents: revenue, avgTicketCents: done.length ? Math.round(revenue / done.length) : 0,
      discountCents: done.reduce((a, s) => a + (s.discountCents ?? 0), 0),
      cancelledCount: cancelled.length, cancelledCents: cancelled.reduce((a, s) => a + s.totalCents, 0),
      items: done.reduce((a, s) => a + (s.items ?? []).reduce((b, i) => b + i.quantity, 0), 0),
    },
    /** O que entrou no caixa da loja: vendas + fiado recebido, por forma. */
    drawer, drawerTotalCents: drawerTotal,
    online: { count: onlineCount, totalCents: online },
    fiado: { soldCount: fiadoCount, soldCents: fiado, receivedCents: payments.filter((p) => isDrawer(p.method)).reduce((a, p) => a + p.amountCents, 0), receivedCount: payments.length },
    // Gaveta: troco inicial + vendas em dinheiro + fiado recebido em dinheiro − devoluções em dinheiro − retiradas.
    cash: { openingCents, salesCents: salesBy.cash, fiadoCents: receivedBy.cash, refundCents: refundBy.cash, withdrawnCents: withdrawn, expectedCents: openingCents + salesBy.cash + receivedBy.cash - refundBy.cash - withdrawn },
    /** Trocas do dia: quantas, valor devolvido, quanto voltou em dinheiro e quanto virou crédito. */
    exchanges: { count: exchanges.length, returnedCents: exchanges.reduce((a, x) => a + x.returnedCents, 0), refundCents: exchanges.reduce((a, x) => a + x.refundCents, 0), creditCents: exchanges.reduce((a, x) => a + x.creditCents, 0) },
    byStaff: [...staff].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.totalCents - a.totalCents),
    byHour: [...hours].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => a.hour - b.hour),
    topProducts: [...products].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.totalCents - a.totalCents).slice(0, 5),
  };
}
export type DaySummary = ReturnType<typeof daySummary>;

/** Valor em centavos digitado no fechamento (troco inicial ou dinheiro contado). */
export function centsOk(v: unknown, label: string): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100_000_000) throw new BadRequestException({ code: 'CLOSE_INVALID', message: `${label}: valor inválido.` });
  return v as number;
}
