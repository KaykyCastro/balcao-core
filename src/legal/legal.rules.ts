/**
 * Regras de proteção de dados (LGPD) e registros que a lei manda guardar. Puras, testadas em legal.spec.ts.
 *
 * - Pedidos do titular (LGPD, art. 18): qualquer pessoa abre pelo site, confirma o e-mail com um código e recebe um
 *   protocolo. Prazo de resposta: 15 dias (art. 19, II).
 * - Registros de acesso (Marco Civil da Internet, art. 15): 6 meses; guardamos 190 dias por folga.
 * - Prova de aceite dos termos e encerramento de conta: 5 anos (prazo prescricional do CDC, art. 27, e fiscal).
 * Esses registros ficam mesmo depois que a conta é excluída (LGPD, art. 16, I: cumprimento de obrigação legal).
 */

export const REQUEST_KINDS = {
  acesso: 'Saber se vocês têm meus dados e ver quais são',
  correcao: 'Corrigir dados incompletos ou errados',
  exclusao: 'Excluir meus dados',
  portabilidade: 'Receber uma cópia dos meus dados',
  compartilhamento: 'Saber com quem meus dados foram compartilhados',
  revogacao: 'Retirar um consentimento que dei',
  oposicao: 'Me opor a um uso dos meus dados',
  outro: 'Outro pedido ou dúvida sobre privacidade',
} as const;
export type RequestKind = keyof typeof REQUEST_KINDS;

export const REQUESTER_ROLES = {
  lojista: 'Tenho conta de lojista no Balcão',
  comprador: 'Comprei ou tenho conta nas lojas online',
  cliente: 'Sou cliente de uma loja que usa o Balcão (cadastro feito pela loja)',
  colaborador: 'Sou colaborador de uma loja',
  outro: 'Outro',
} as const;
export type RequesterRole = keyof typeof REQUESTER_ROLES;

export const REQUEST_STATUSES = ['unverified', 'open', 'in_progress', 'done', 'rejected'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const RESPONSE_DAYS = 15;
export const ACCESS_LOG_DAYS = 190;
export const RETENTION_YEARS = 5;
export const CODE_TTL_MIN = 30;
export const CODE_MAX_WRONG = 5;

const DAY = 86_400_000;
/** Prazo legal de resposta, contado da confirmação do e-mail. */
export const dueDate = (verifiedAt: Date) => new Date(verifiedAt.getTime() + RESPONSE_DAYS * DAY);
export const daysLeft = (due: Date, now = new Date()) => Math.ceil((due.getTime() - now.getTime()) / DAY);

/** Protocolo legível: LGPD-2026-000123 (ano + sequência). */
export const protocolOf = (year: number, seq: number) => `LGPD-${year}-${String(seq).padStart(6, '0')}`;

/** Quem pode mudar para onde (admin). Fechado (done/rejected) não reabre: um pedido novo é aberto. */
export function canMove(from: RequestStatus, to: RequestStatus): boolean {
  if (from === 'unverified') return false;
  if (from === 'done' || from === 'rejected') return false;
  if (to === 'unverified' || to === from) return false;
  return true;
}

/** Recusa precisa de motivo (art. 18, §4º: informar as razões de fato ou de direito). Conclusão também leva resposta. */
export function responseProblem(to: RequestStatus, response: string): string | null {
  if ((to === 'done' || to === 'rejected') && response.trim().length < 10) {
    return to === 'rejected' ? 'Explique o motivo da recusa (a LGPD exige informar as razões).' : 'Escreva a resposta que vai para o titular.';
  }
  return null;
}

/**
 * Pedidos de loja online que ainda envolvem o comprador (pago e não entregue, ou combinado na entrega): com eles em aberto
 * o lojista não pode sumir; primeiro entrega, cancela ou devolve (Código de Defesa do Consumidor).
 */
export const OPEN_ORDER_STATUSES = ['confirmed', 'paid', 'preparing', 'ready_for_pickup', 'shipped'] as const;

/**
 * Coleções que FICAM quando o lojista exclui a conta (obrigação legal/fiscal do Balcão): faturas e lançamentos da taxa.
 * Todo o resto que tem `enterpriseId` é apagado.
 */
export const RETAINED_ON_CLOSE = ['Invoice', 'FeeEntry'] as const;
