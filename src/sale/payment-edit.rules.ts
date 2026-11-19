/**
 * Corrigir a forma de pagamento de uma venda do balcão (ex.: o caixa marcou Pix e o cliente pagou em dinheiro).
 * Só muda COMO o dinheiro novo entrou: total, itens, estoque e taxa ficam iguais (a taxa não depende da forma).
 * Fiado mexe na dívida do cliente: virar fiado soma a dívida, deixar de ser fiado abate (só se a dívida ainda existe).
 */
export const EDITABLE_METHODS = ['cash', 'pix', 'card', 'other', 'fiado'] as const;
export type EditableMethod = (typeof EDITABLE_METHODS)[number];

export interface EditableSale {
  channel?: 'pos' | 'online';
  status: 'completed' | 'cancelled';
  paymentMethod: string;
  totalCents: number;
  creditCents?: number;
  exchangeCents?: number;
  customerId?: unknown;
  payment?: { provider?: string } | null;
}

export class PaymentEditError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** O que a venda cobrou agora (fora crédito da loja e valor de troca). */
export const dueOf = (s: Pick<EditableSale, 'totalCents' | 'creditCents' | 'exchangeCents'>) =>
  Math.max(0, s.totalCents - (s.creditCents ?? 0) - (s.exchangeCents ?? 0));

/**
 * Confere a troca e diz o efeito na dívida do cliente: `debtDelta` > 0 soma, < 0 abate, 0 nada.
 * Lança `PaymentEditError` com o código que o painel mostra.
 */
export function judgePaymentEdit(sale: EditableSale, to: string): { dueCents: number; debtDelta: number } {
  if (sale.channel === 'online') throw new PaymentEditError('PAYMENT_EDIT_ONLINE', 'Venda da loja online: o pagamento foi feito pelo Mercado Pago e não pode ser trocado aqui.');
  if (sale.status !== 'completed') throw new PaymentEditError('PAYMENT_EDIT_CANCELLED', 'Venda cancelada: não há pagamento para corrigir.');
  if (sale.payment?.provider) throw new PaymentEditError('PAYMENT_EDIT_ELECTRONIC', 'Este pagamento foi confirmado pela maquininha ou pelo Pix automático. Para corrigir, cancele a venda e faça de novo.');
  if (!(EDITABLE_METHODS as readonly string[]).includes(to)) throw new PaymentEditError('PAYMENT_EDIT_METHOD', 'Forma de pagamento inválida.');
  if (!(EDITABLE_METHODS as readonly string[]).includes(sale.paymentMethod)) throw new PaymentEditError('PAYMENT_EDIT_NOTHING_DUE', 'Esta venda foi paga toda com crédito da loja ou com uma troca: não há forma de pagamento para trocar.');
  if (sale.paymentMethod === to) throw new PaymentEditError('PAYMENT_EDIT_SAME', 'A venda já está com essa forma de pagamento.');
  const dueCents = dueOf(sale);
  if (dueCents <= 0) throw new PaymentEditError('PAYMENT_EDIT_NOTHING_DUE', 'Não há valor cobrado nesta venda para trocar a forma.');
  if (to === 'fiado' && !sale.customerId) throw new PaymentEditError('PAYMENT_EDIT_NEEDS_CUSTOMER', 'Para passar para o fiado, a venda precisa ter um cliente.');
  const debtDelta = to === 'fiado' ? dueCents : sale.paymentMethod === 'fiado' ? -dueCents : 0;
  return { dueCents, debtDelta };
}
