/**
 * Cliente da loja ligado à conta do marketplace ("pertencer à loja").
 *
 * - Ninguém é ligado sem consentimento: o comprador pede para ser cliente, ou aceita o convite da loja.
 * - Fiado numa conta do marketplace só depois de pertencer à loja. Cadastros feitos pelo lojista
 *   sem conta online (o caderninho de sempre) continuam podendo comprar fiado.
 * - Quem pertence só sai (ou é desligado) com o saldo quitado.
 */
export interface MemberLike {
  shopperId?: unknown;
  memberSince?: Date | string | null;
  origin?: 'pos' | 'online';
  debitCents?: number;
}

/** Pertence à loja: aceitou (memberSince) ou foi ligado pelo lojista antes do consentimento existir (cadastro do balcão já ligado). */
export function isMember(c: MemberLike): boolean {
  if (!c.shopperId) return false;
  return !!c.memberSince || c.origin !== 'online';
}

/** Pode receber fiado: cadastro só do lojista (sem conta online) ou membro. */
export function canOwe(c: MemberLike): boolean {
  return !c.shopperId || isMember(c);
}

/** Pode sair da loja (ou ser desligado): só sem saldo em aberto. */
export function canLeave(c: MemberLike): boolean {
  return (c.debitCents ?? 0) <= 0;
}

export const onlyDigits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
/** Telefone comparável: últimos 10 dígitos (DDD + número, sem o 9 extra nem o +55). */
export const phoneKey = (s: string | null | undefined) => { const d = onlyDigits(s); if (d.length < 10) return ''; const n = d.slice(-11); return n.length === 11 ? n.slice(0, 2) + n.slice(3) : n.slice(-10); };
export const nameKey = (s: string | null | undefined) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).join(' ');

export interface MatchCandidate { email?: string; numberWithPrefix?: string; name?: string }
export interface MatchPerson { email: string; phone?: string; name: string }

/**
 * Quanto um cadastro do lojista parece ser a pessoa da conta online (para sugerir a união).
 * E-mail igual pesa mais; telefone igual vem em seguida; nome igual sozinho é só uma pista.
 */
export function matchReasons(c: MatchCandidate, p: MatchPerson): { score: number; reasons: ('email' | 'phone' | 'name')[] } {
  const reasons: ('email' | 'phone' | 'name')[] = [];
  let score = 0;
  if (c.email && p.email && c.email.trim().toLowerCase() === p.email.trim().toLowerCase()) { score += 60; reasons.push('email'); }
  const cp = phoneKey(c.numberWithPrefix); const pp = phoneKey(p.phone);
  if (cp && pp && cp === pp) { score += 30; reasons.push('phone'); }
  const cn = nameKey(c.name); const pn = nameKey(p.name);
  if (cn && pn && (cn === pn || (cn.split(' ')[0] === pn.split(' ')[0] && cn.split(' ').at(-1) === pn.split(' ').at(-1)))) { score += 10; reasons.push('name'); }
  return { score, reasons };
}

/** Recado do comprador ao pedir para ser cliente: texto curto, sem caracteres de controle. */
export const cleanMessage = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '');
