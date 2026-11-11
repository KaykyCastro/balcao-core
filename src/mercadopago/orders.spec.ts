import { ConfigService } from '@nestjs/config';
import { isOrderId, MercadoPagoClient, MP_PAYMENT_ID_RE, orderAsPayment } from './mercadopago.client';

describe('Checkout Pro pela API de Orders', () => {
  it('reconhece ids de ordem e de pagamento antigo', () => {
    expect(isOrderId('ORD01JQ4S4KY8HWQ6NA5PXB65B3D3')).toBe(true);
    expect(isOrderId('ORDTST01M4V4VSXCTN8ZN1FJ02KKMFGE')).toBe(true);
    expect(isOrderId('188964992036')).toBe(false);
    expect(MP_PAYMENT_ID_RE.test('188964992036')).toBe(true);
    expect(MP_PAYMENT_ID_RE.test('ord01abc')).toBe(false);
  });

  it('ordem vira o mesmo formato de pagamento que as confirmações conferem', () => {
    const base = { id: 'ORD01A', external_reference: 'abc', user_id: 3827113160, total_paid_amount: '19.90', marketplace_fee: '0.30', transactions: { payments: [{ payment_method: { type: 'credit_card' } }] } };
    expect(orderAsPayment({ ...base, status: 'processed', status_detail: 'accredited' })).toMatchObject({ id: 'ORD01A', status: 'approved', externalReference: 'abc', collectorId: '3827113160', amountCents: 1990, marketplaceFeeCents: 30, method: 'credit_card' });
    expect(orderAsPayment({ ...base, status: 'refunded', status_detail: 'refunded' }).status).toBe('refunded');
    expect(orderAsPayment({ ...base, status: 'failed', status_detail: 'rejected_by_issuer' }).status).toBe('rejected');
    expect(orderAsPayment({ ...base, status: 'canceled', status_detail: 'canceled' }).status).toBe('cancelled');
    expect(orderAsPayment({ ...base, status: 'processing', status_detail: 'in_process' }).status).toBe('in_process');
    expect(orderAsPayment({ ...base, status: 'created', status_detail: 'created', total_paid_amount: '0.00' })).toMatchObject({ status: 'created', amountCents: 0 });
  });

  it('consulta e reembolso de ordem usam /v1/orders', async () => {
    const calls: { url: string; method: string }[] = [];
    global.fetch = jest.fn(async (url: string, init: any) => { calls.push({ url, method: init.method }); return { ok: true, status: 200, json: async () => ({ id: 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3', status: 'processed', status_detail: 'accredited', total_paid_amount: '10.00', user_id: 1 }) } as any; }) as any;
    const mp = new MercadoPagoClient(new ConfigService({}));
    const p = await mp.payment('ORD01JQ4S4KY8HWQ6NA5PXB65B3D3', 'T');
    expect(p.status).toBe('approved');
    await mp.refund('ORD01JQ4S4KY8HWQ6NA5PXB65B3D3', 'T', 'r1');
    await mp.refund('188964992036', 'T', 'r2');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.mercadopago.com', '')}`)).toEqual([
      'GET /v1/orders/ORD01JQ4S4KY8HWQ6NA5PXB65B3D3', 'POST /v1/orders/ORD01JQ4S4KY8HWQ6NA5PXB65B3D3/refund', 'POST /v1/payments/188964992036/refunds',
    ]);
  });
});
