import { MODE_RULES, type OrderStatus, type ShippingKind, type StoreMode } from './store.rules';

const DAY = 86_400_000;

/**
 * Compra protegida (regras da plataforma).
 * - A loja tem `shipDays` (retirada: `pickupDays`) para enviar ou deixar pronto. Passou do prazo + `graceDays`: cancela e devolve.
 * - Entregue: o comprador tem `confirmDays` para reclamar; depois disso, a compra é dada como recebida.
 * - Reclamação sem resposta da loja em `replyDays` sobe para a equipe do Balcão decidir.
 */
export const PROTECTION = { shipDays: 3, pickupDays: 2, graceDays: 2, confirmDays: 7, replyDays: 3, regretDays: 7 } as const;

export const DISPUTE_REASONS = {
  not_received: 'Não recebi o pedido',
  damaged: 'Chegou com defeito ou danificado',
  different: 'Diferente do anunciado',
  regret: 'Desisti da compra (7 dias)',
} as const;
export type DisputeReason = keyof typeof DISPUTE_REASONS;

const HOUR = 3_600_000;
/** Prazos dependem do modo da loja (e-commerce em dias, cardápio em horas). */
export const shipByOf = (kind: ShippingKind, from: Date, mode: StoreMode = 'ecommerce') => new Date(from.getTime() + (kind === 'pickup' ? MODE_RULES[mode].pickupHours : MODE_RULES[mode].shipHours) * HOUR);
export const autoConfirmOf = (deliveredAt: Date, mode: StoreMode = 'ecommerce') => new Date(deliveredAt.getTime() + MODE_RULES[mode].confirmHours * HOUR);
export const graceEnd = (shipBy: Date, mode: StoreMode = 'ecommerce') => new Date(shipBy.getTime() + MODE_RULES[mode].graceHours * HOUR);

type O = {
  status: OrderStatus; shipping: { kind: ShippingKind };
  protection?: { status: string; shipBy: Date | null; mode?: StoreMode | null } | null;
  dispute?: { status: string } | null;
  payment?: { refundedAt?: Date | null } | null;
  history?: { status: string; at: Date }[];
};
const fmtDay = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', ...(d.getTime() - Date.now() < 86_400_000 ? { hour: '2-digit', minute: '2-digit' } : {}) });

/** null = pode abrir; texto = por que não pode (mostrado ao comprador). */
export function disputeBlock(o: O, reason: DisputeReason, now = new Date()): string | null {
  if (o.shipping.kind === 'table') return 'Pedidos na mesa são resolvidos direto com a loja, no local.';
  if (!['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'].includes(o.status)) return 'Este pedido não está pago ou já foi cancelado.';
  if (o.payment?.refundedAt || o.protection?.status === 'refunded') return 'Este pedido já foi reembolsado.';
  if (o.dispute?.status === 'open') return 'Já existe uma reclamação aberta para este pedido.';
  if (reason === 'not_received' && ['paid', 'preparing'].includes(o.status) && o.protection?.shipBy && now < new Date(o.protection.shipBy)) {
    return `A loja tem até ${fmtDay(new Date(o.protection.shipBy))} para enviar. Se não enviar, o pedido é cancelado e o dinheiro volta sozinho.`;
  }
  if ((reason === 'damaged' || reason === 'different') && !['shipped', 'delivered', 'ready_for_pickup'].includes(o.status)) return 'Dá para relatar defeito depois de receber o pedido.';
  if (reason === 'regret' && o.protection?.mode && !MODE_RULES[o.protection.mode].regret) return 'Pedidos de comida não têm prazo de desistência. Se veio errado ou com problema, escolha outro motivo.';
  if (reason === 'regret') {
    const at = [...(o.history ?? [])].reverse().find((h) => h.status === 'delivered')?.at;
    if (o.status !== 'delivered' || !at) return 'O prazo de 7 dias para desistir conta a partir do recebimento.';
    if (now.getTime() - new Date(at).getTime() > PROTECTION.regretDays * DAY) return 'O prazo de 7 dias para desistir já passou. Ainda dá para relatar defeito.';
  }
  return null;
}
