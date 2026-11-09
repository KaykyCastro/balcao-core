/**
 * Avisos da fatura do sistema (e-mail, sino do painel e, se o lojista quiser, WhatsApp), para a conta não ser
 * bloqueada por esquecimento. A conta é bloqueada no instante em que a fatura vence, então os avisos vêm antes.
 *
 * - issued: a fatura saiu (com o prazo); com cobrança automática, avisa a data em que o cartão será cobrado;
 * - d3: faltam 3 dias; d1: vence amanhã (a conta é bloqueada se não pagar);
 * - overdue: venceu e a conta foi bloqueada (pagar libera na hora).
 * Cada aviso sai uma vez por fatura; se a rotina atrasar, sai só o mais urgente que ainda faz sentido.
 */
export type ReminderKind = 'issued' | 'd3' | 'd1' | 'overdue';
const RANK: Record<ReminderKind, number> = { issued: 0, d3: 1, d1: 2, overdue: 3 };
const DAY = 86_400_000;

export interface ReminderInvoice { status: string; dueDate: Date; reminders?: { kind: string }[] | null }

/** Qual aviso mandar agora (ou nenhum). Com cartão autorizado, só o "saiu" e o "venceu" (se o cartão falhar). */
export function reminderDue(inv: ReminderInvoice, now: Date, opts: { autopay?: boolean } = {}): ReminderKind | null {
  if (inv.status !== 'pending') return null;
  const left = inv.dueDate.getTime() - now.getTime();
  const due: ReminderKind = left <= 0 ? 'overdue' : left <= DAY ? 'd1' : left <= 3 * DAY ? 'd3' : 'issued';
  if (opts.autopay && (due === 'd3' || due === 'd1')) return null;
  const sent = (inv.reminders ?? []).map((r) => RANK[r.kind as ReminderKind] ?? -1);
  const top = sent.length ? Math.max(...sent) : -1;
  return RANK[due] > top ? due : null;
}

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ');
const day = (d: Date) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });

export interface ReminderText { subject: string; title: string; text: string; /** Frase curta para o modelo do WhatsApp ({{2}}). */ short: string }

export function reminderText(kind: ReminderKind, p: { name: string; amountCents: number; dueDate: Date; link: string; autopay?: { chargeOn?: Date | null } | null }): ReminderText {
  const v = brl(p.amountCents); const d = day(p.dueDate); const first = p.name.split(' ')[0] || p.name;
  const auto = p.autopay ? ` Ela será cobrada no cartão cadastrado no Mercado Pago${p.autopay.chargeOn ? ` em ${day(p.autopay.chargeOn)}` : ''}; você não precisa fazer nada.` : '';
  const pay = `Para pagar (Pix ou cartão): ${p.link}`;
  switch (kind) {
    case 'issued': return {
      subject: `Sua fatura do Balcão: ${v}, vence em ${d}`, title: `Fatura do Balcão: ${v}, vence em ${d}`,
      short: p.autopay ? `sua fatura saiu e será cobrada no cartão` : `sua fatura saiu e vence em ${d}`,
      text: `Olá, ${first}!\n\nA fatura de uso do Balcão saiu: ${v}, com vencimento em ${d}.${auto}\n\n${p.autopay ? `Se preferir pagar agora: ${p.link}` : `${pay}\n\nNo vencimento, sem pagamento, o sistema é bloqueado até a fatura ser paga.`}`,
    };
    case 'd3': return {
      subject: `Faltam 3 dias para a fatura do Balcão (${v})`, title: `Faltam 3 dias para a fatura (${v})`, short: `faltam 3 dias para a sua fatura vencer`,
      text: `Olá, ${first}!\n\nA fatura do Balcão de ${v} vence em ${d}. Pague antes para o caixa não parar.\n\n${pay}`,
    };
    case 'd1': return {
      subject: `Sua fatura do Balcão vence amanhã (${v})`, title: `A fatura vence amanhã (${v})`, short: `sua fatura vence amanhã e o sistema será bloqueado sem o pagamento`,
      text: `Olá, ${first}!\n\nA fatura do Balcão de ${v} vence amanhã, ${d}. Sem o pagamento, o sistema (caixa, estoque e loja online) é bloqueado até a fatura ser paga.\n\n${pay}`,
    };
    case 'overdue': return {
      subject: `Fatura do Balcão vencida: sistema bloqueado (${v})`, title: `Fatura vencida: sistema bloqueado (${v})`, short: `sua fatura venceu e o sistema foi bloqueado; pague para liberar na hora`,
      text: `Olá, ${first}!\n\nA fatura do Balcão de ${v} venceu em ${d}${p.autopay ? ' e a cobrança no cartão não foi aprovada' : ''}, e o sistema foi bloqueado. Pagando, ele é liberado na hora.\n\n${pay}`,
    };
  }
}

/** Celular brasileiro para o WhatsApp: só dígitos, com 55 + DDD + número (10 ou 11 dígitos). null = inválido. */
export function waNumber(s: string | null | undefined): string | null {
  const d = String(s ?? '').replace(/\D/g, '');
  const n = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d : d.length === 10 || d.length === 11 ? `55${d}` : '';
  return n && /^55[1-9]{2}\d{8,9}$/.test(n) ? n : null;
}
