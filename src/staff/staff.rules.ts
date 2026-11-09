/**
 * Funcionários (caixa e garçom): o que cada permissão libera na API.
 * Regra geral: funcionário só acessa o que está listado aqui; o resto (equipe, configurações, faturas, admin...) é só do dono.
 */
export const STAFF_PERMS = ['sales', 'tables', 'orders', 'stock', 'customers', 'reports'] as const;
export type StaffPerm = (typeof STAFF_PERMS)[number];
export const PERM_LABEL: Record<StaffPerm, string> = {
  sales: 'Vender no caixa', tables: 'Mesas e comandas', orders: 'Pedidos da loja online', stock: 'Estoque, produtos e promoções', customers: 'Clientes e fiado', reports: 'Relatórios e painel',
};
export const STAFF_ROLES = ['cashier', 'waiter'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const ROLE_LABEL: Record<StaffRole, string> = { cashier: 'Atendente de caixa', waiter: 'Garçom' };
export const ROLE_DEFAULT: Record<StaffRole, StaffPerm[]> = { cashier: ['sales', 'customers'], waiter: ['tables'] };

type Rule = { re: RegExp; read?: StaffPerm[]; write?: StaffPerm[]; any?: true; noShift?: true };
/** Fora do horário de acesso: só o necessário para ver o aviso, sair e encerrar o turno. */
export const OFF_HOURS_ALLOWED = /^\/(auth\/(me|logout)|staff\/me|staff\/shift\/end)$/;

const RULES: Rule[] = [
  // sempre (sessão, turno, dados da empresa para o comprovante)
  { re: /^\/auth\/(me|logout)$/, any: true, noShift: true },
  { re: /^\/staff\/(me|shift)(\/.*)?$/, any: true, noShift: true },
  // layout da tela de vendas: todos usam o do dono; só o dono muda (sem regra de escrita)
  { re: /^\/enterprise\/[a-f0-9]{24}\/pdv-layout$/, read: ['sales', 'tables', 'orders', 'stock', 'customers', 'reports'] },
  { re: /^\/enterprise\/[a-f0-9]{24}$/, read: ['sales', 'tables', 'orders', 'stock', 'customers', 'reports'] },
  { re: /^\/billing\/summary$/, read: ['sales', 'tables', 'orders', 'stock', 'customers', 'reports'], noShift: true },
  // caixa
  { re: /^\/sale(\/.*)?$/, read: ['sales', 'reports'], write: ['sales'] },
  { re: /^\/pos\/config$/, read: ['sales', 'tables'] },
  { re: /^\/pos\/charges(\/.*)?$/, read: ['sales', 'tables'], write: ['sales', 'tables'] },
  { re: /^\/report\/popular-products$/, read: ['sales', 'tables', 'reports'] },
  { re: /^\/report\/stock(\/.*)?$/, read: ['stock', 'reports'] },
  { re: /^\/report(\/.*)?$/, read: ['reports'] },
  // produtos: ver para vender; mudar só com estoque
  { re: /^\/product(\/.*)?$/, read: ['sales', 'tables', 'orders', 'stock'], write: ['stock'] },
  // envio de fotos de produto (o controller só deixa colaborador enviar tipo 'product')
  { re: /^\/uploads\/(presign|[a-f0-9]{24}\/complete)$/, write: ['stock'] },
  { re: /^\/category(\/.*)?$/, read: ['sales', 'tables', 'orders', 'stock'], write: ['stock'] },
  { re: /^\/promotion(\/.*)?$/, read: ['sales', 'tables', 'stock'], write: ['stock'] },
  { re: /^\/customer(\/.*)?$/, read: ['sales', 'customers'], write: ['customers'] },
  // salão e loja online
  { re: /^\/tabs(\/.*)?$/, read: ['tables'], write: ['tables'] },
  { re: /^\/orders\/summary$/, read: ['orders', 'tables'] },
  { re: /^\/orders(\/.*)?$/, read: ['orders'], write: ['orders'] },
  { re: /^\/store-config$/, read: ['orders', 'tables'] },
  { re: /^\/store-config\/fees$/, read: ['stock'] },
];

/** null = pode; texto = motivo da recusa. needsShift: a rota exige turno aberto. */
export function staffAccess(method: string, path: string, perms: readonly string[]): { ok: boolean; needsShift: boolean } {
  const p = path.split('?')[0].replace(/\/+$/, '') || '/';
  const rule = RULES.find((r) => r.re.test(p));
  if (!rule) return { ok: false, needsShift: false };
  if (rule.any) return { ok: true, needsShift: !rule.noShift };
  const read = ['GET', 'HEAD'].includes(method.toUpperCase());
  const need = read ? rule.read : rule.write;
  return { ok: !!need?.some((x) => perms.includes(x)), needsShift: !rule.noShift };
}

// ------------------------------------------------------------------ horários de acesso

/** Fuso dos horários de acesso (o mesmo de Brasília; o Balcão ainda não tem fuso por loja). */
export const STAFF_TZ = 'America/Sao_Paulo';
export const DAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Uma faixa de horário num dia da semana (0 = domingo). Fim menor ou igual ao início = vira a meia-noite (ex.: 18:00 às 02:00). */
export interface ScheduleWindow { day: number; start: string; end: string }
/** enabled = false: acessa a qualquer hora. enabled sem faixas: não acessa nunca. */
export interface StaffSchedule { enabled: boolean; windows: ScheduleWindow[] }

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Dia da semana e minuto do dia no fuso da loja. */
export function localClock(now: Date, tz = STAFF_TZ): { day: number; minute: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { day: WEEKDAY[get('weekday')] ?? 0, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function withinSchedule(s: StaffSchedule | null | undefined, now: Date = new Date(), tz = STAFF_TZ): boolean {
  if (!s?.enabled) return true;
  const { day, minute } = localClock(now, tz);
  const yesterday = (day + 6) % 7;
  return s.windows.some((w) => {
    const a = toMin(w.start), b = toMin(w.end);
    if (b > a) return w.day === day && minute >= a && minute < b;
    return (w.day === day && minute >= a) || (w.day === yesterday && minute < b); // vira a meia-noite
  });
}

/** "hoje às 18:00", "amanhã às 08:00", "seg às 08:00" ou null (nenhuma faixa). */
export function nextOpening(s: StaffSchedule | null | undefined, now: Date = new Date(), tz = STAFF_TZ): string | null {
  if (!s?.enabled || !s.windows.length) return null;
  const { day, minute } = localClock(now, tz);
  for (let d = 0; d <= 7; d++) {
    const wd = (day + d) % 7;
    const starts = s.windows.filter((w) => w.day === wd).map((w) => w.start).sort();
    const next = starts.find((t) => d > 0 || toMin(t) > minute);
    if (next) return `${d === 0 ? 'hoje' : d === 1 ? 'amanhã' : DAY_SHORT[wd]} às ${next}`;
  }
  return null;
}

/** Faixas válidas, sem repetição e em ordem (dia, início). */
export function normalizeSchedule(s: StaffSchedule): StaffSchedule {
  const seen = new Set<string>();
  const windows = s.windows
    .filter((w) => Number.isInteger(w.day) && w.day >= 0 && w.day <= 6 && TIME_RE.test(w.start) && TIME_RE.test(w.end) && w.start !== w.end)
    .filter((w) => { const k = `${w.day}-${w.start}-${w.end}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return { enabled: !!s.enabled, windows };
}

// ------------------------------------------------------------------ horas trabalhadas

/** Horas dos turnos dentro do período [since, now] (turno aberto conta até agora). */
export function workedMs(shifts: { startedAt: Date; endedAt: Date | null }[], since: Date, now: Date = new Date()): number {
  return shifts.reduce((acc, s) => {
    const a = Math.max(s.startedAt.getTime(), since.getTime());
    const b = Math.min((s.endedAt ?? now).getTime(), now.getTime());
    return acc + Math.max(0, b - a);
  }, 0);
}
