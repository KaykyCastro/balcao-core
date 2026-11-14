import { judgeTapResult, maxInstallments, returnUrlOk, tapDeeplink } from './tap.rules';

describe('InfiniteTap: regras', () => {
  const charge = { orderId: 'a'.repeat(32), status: 'pending', expiresAt: new Date(Date.now() + 10 * 60_000) };
  const cfg = { handle: 'minhaloja', doc: '27346981000144' };
  const ok = { orderId: 'a'.repeat(32), nsu: 'a1f8d73b-9b3e-4e5d-9c34-d8e917d43b1a', aut: 'A1B2C3', cardBrand: 'Mastercard', handle: 'minhaloja', merchantDocument: '27.346.981/0001-44' };

  it('monta o deep link com valor em centavos, conta da loja e retorno do app', () => {
    const u = new URL(tapDeeplink({ amountCents: 1250, method: 'credit', installments: 3, orderId: 'x1', resultUrl: 'balcao://tap', handle: '$MinhaLoja', doc: '27.346.981/0001-44' }));
    expect(u.protocol).toBe('infinitepaydash:');
    expect(u.searchParams.get('amount')).toBe('1250');
    expect(u.searchParams.get('installments')).toBe('3');
    expect(u.searchParams.get('handle')).toBe('minhaloja');
    expect(u.searchParams.get('doc_number')).toBe('27346981000144');
    expect(u.searchParams.get('result_url')).toBe('balcao://tap');
  });

  it('débito vai sempre em 1 parcela', () => {
    const u = new URL(tapDeeplink({ amountCents: 5000, method: 'debit', installments: 6, orderId: 'x', resultUrl: 'balcao://tap', handle: 'loja' }));
    expect(u.searchParams.get('installments')).toBe('1');
  });

  it('parcela mínima de R$ 1,00 e no máximo 12', () => {
    expect(maxInstallments(250)).toBe(2);
    expect(maxInstallments(99_999)).toBe(12);
    expect(maxInstallments(50)).toBe(1);
  });

  it('retorno só para o próprio app (nunca um site)', () => {
    expect(returnUrlOk('balcao://tap', false)).toBe(true);
    expect(returnUrlOk('https://evil.example/tap', true)).toBe(false);
    expect(returnUrlOk('exp://192.168.0.10:8081/--/tap', false)).toBe(false);
    expect(returnUrlOk('exp://192.168.0.10:8081/--/tap', true)).toBe(true);
    expect(returnUrlOk('balcao://tap?x=<script>', false)).toBe(false);
  });

  it('aprova o retorno certo', () => {
    expect(judgeTapResult(charge, cfg, ok)).toEqual({ ok: true, nsu: ok.nsu, aut: 'A1B2C3', brand: 'mastercard' });
  });

  it('recusa retorno de outra cobrança (order_id diferente)', () => {
    expect(judgeTapResult(charge, cfg, { ...ok, orderId: 'b'.repeat(32) })).toMatchObject({ ok: false, code: 'TAP_ORDER_MISMATCH' });
    expect(judgeTapResult(charge, cfg, { ...ok, orderId: '' })).toMatchObject({ ok: false, code: 'TAP_ORDER_MISMATCH' });
  });

  it('recusa cobrança já encerrada ou vencida', () => {
    expect(judgeTapResult({ ...charge, status: 'paid' }, cfg, ok)).toMatchObject({ code: 'TAP_NOT_PENDING' });
    expect(judgeTapResult({ ...charge, expiresAt: new Date(Date.now() - 5 * 60_000) }, cfg, ok)).toMatchObject({ code: 'TAP_EXPIRED' });
  });

  it('recusa pagamento recebido em outra conta InfinitePay', () => {
    expect(judgeTapResult(charge, cfg, { ...ok, handle: 'outra' })).toMatchObject({ code: 'TAP_WRONG_ACCOUNT' });
    expect(judgeTapResult(charge, cfg, { ...ok, handle: '' })).toMatchObject({ code: 'TAP_WRONG_ACCOUNT' });
    expect(judgeTapResult(charge, cfg, { ...ok, merchantDocument: '11.111.111/0001-11' })).toMatchObject({ code: 'TAP_WRONG_ACCOUNT' });
  });

  it('com aviso, sem NSU ou sem autorização, não paga', () => {
    expect(judgeTapResult(charge, cfg, { ...ok, warning: 'order_id is empty' })).toMatchObject({ code: 'TAP_NOT_PAID' });
    expect(judgeTapResult(charge, cfg, { ...ok, nsu: '' })).toMatchObject({ code: 'TAP_NOT_PAID' });
    expect(judgeTapResult(charge, cfg, { ...ok, aut: '' })).toMatchObject({ code: 'TAP_NOT_PAID' });
    expect(judgeTapResult(charge, cfg, { ...ok, nsu: "1' OR 1=1" })).toMatchObject({ code: 'TAP_NOT_PAID' });
  });
});
