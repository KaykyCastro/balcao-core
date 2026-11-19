import { dueOf, judgePaymentEdit, PaymentEditError } from './payment-edit.rules';

const sale = (o: Record<string, unknown> = {}) => ({ channel: 'pos' as const, status: 'completed' as const, paymentMethod: 'pix', totalCents: 10000, customerId: 'c1', payment: null, ...o });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as PaymentEditError).code; } return 'ok'; };

describe('corrigir forma de pagamento', () => {
  it('Pix → dinheiro: só muda a forma, sem mexer na dívida', () => {
    expect(judgePaymentEdit(sale(), 'cash')).toEqual({ dueCents: 10000, debtDelta: 0 });
  });

  it('fiado entra e sai da dívida pelo valor cobrado (fora crédito e troca)', () => {
    expect(judgePaymentEdit(sale({ creditCents: 3000 }), 'fiado')).toEqual({ dueCents: 7000, debtDelta: 7000 });
    expect(judgePaymentEdit(sale({ paymentMethod: 'fiado', exchangeCents: 2500 }), 'card')).toEqual({ dueCents: 7500, debtDelta: -7500 });
  });

  it('recusa: online, cancelada, maquininha/Pix automático, mesma forma, sem cliente para fiado', () => {
    expect(code(() => judgePaymentEdit(sale({ channel: 'online', paymentMethod: 'online' }), 'cash'))).toBe('PAYMENT_EDIT_ONLINE');
    expect(code(() => judgePaymentEdit(sale({ status: 'cancelled' }), 'cash'))).toBe('PAYMENT_EDIT_CANCELLED');
    expect(code(() => judgePaymentEdit(sale({ payment: { provider: 'mercadopago' } }), 'cash'))).toBe('PAYMENT_EDIT_ELECTRONIC');
    expect(code(() => judgePaymentEdit(sale(), 'pix'))).toBe('PAYMENT_EDIT_SAME');
    expect(code(() => judgePaymentEdit(sale({ customerId: null }), 'fiado'))).toBe('PAYMENT_EDIT_NEEDS_CUSTOMER');
    expect(code(() => judgePaymentEdit(sale(), 'online'))).toBe('PAYMENT_EDIT_METHOD');
  });

  it('venda paga toda com crédito ou troca não tem forma para trocar', () => {
    expect(code(() => judgePaymentEdit(sale({ paymentMethod: 'credit', creditCents: 10000 }), 'cash'))).toBe('PAYMENT_EDIT_NOTHING_DUE');
    expect(dueOf({ totalCents: 10000, creditCents: 4000, exchangeCents: 6000 })).toBe(0);
  });
});
