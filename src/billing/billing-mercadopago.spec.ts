import { Types } from 'mongoose';
import { BillingService } from './billing.service';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { sign } from '../common/secret-box';

const okJson = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('MercadoPagoClient', () => {
  afterEach(() => jest.restoreAllMocks());
  const mk = (o: Record<string, string> = {}) => new MercadoPagoClient({ get: (k: string) => ({ MP_ACCESS_TOKEN: 'APP_USR-balcao', ...o })[k] } as any);

  it('fatura: ordem de Checkout Pro (API de Orders) na conta do Balcão, sem comissão, valor em texto e sem boleto', async () => {
    const f = jest.spyOn(global, 'fetch').mockImplementation(() => okJson({ id: 'ORD01INV0000000001', checkout_url: 'https://www.mercadopago.com.br/checkout/v1/redirect?order_id=ORD01INV0000000001' }));
    const c = mk();
    const r = await c.createPreference({ accessToken: c.platformToken, orderId: 'inv1', items: [{ title: 'Taxa', quantity: 1, unitCents: 4000 }], payer: { name: 'Loja', email: 'l@x.com' }, backUrl: 'https://app/x', notificationUrl: 'https://api/w' });
    expect(r).toEqual({ id: 'ORD01INV0000000001', initPoint: expect.stringContaining('https://') });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/v1/orders');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer APP_USR-balcao');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ type: 'online', processing_mode: 'manual', total_amount: '40.00', external_reference: 'inv1', items: [{ unit_price: '40.00', quantity: 1 }], config: { payment_method: { not_allowed_types: ['ticket'] } } });
    expect(body).not.toHaveProperty('marketplace_fee');
    expect(body).not.toHaveProperty('expiration_time');
  });

  it('rejeita link não-https, erro HTTP e falha de rede; sem token: 503', async () => {
    const f = jest.spyOn(global, 'fetch');
    const c = mk();
    const p = { accessToken: 'x', orderId: 'o', items: [], payer: { name: 'a', email: 'b' }, backUrl: 'https://x' };
    f.mockImplementation(() => okJson({ checkout_url: 'javascript:alert(1)' }));
    await expect(c.createPreference(p)).rejects.toMatchObject({ status: 502 });
    f.mockImplementation(() => okJson({}, 500));
    await expect(c.createPreference(p)).rejects.toMatchObject({ status: 502 });
    f.mockRejectedValue(new Error('boom'));
    await expect(c.payment('1', 'x')).rejects.toMatchObject({ status: 502 });
    expect(() => mk({ MP_ACCESS_TOKEN: '' }).platformToken).toThrow(/MP_ACCESS_TOKEN/);
  });

  it('lê o pagamento: valor, status, referência e comissão em centavos', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => okJson({ id: 77, status: 'approved', external_reference: 'inv1', transaction_amount: 40, collector_id: 9, payment_type_id: 'bank_transfer', fee_details: [{ type: 'application_fee', amount: 0.6 }, { type: 'mercadopago_fee', amount: 0.4 }] }));
    expect(await mk().payment('77', 'x')).toMatchObject({ id: '77', status: 'approved', externalReference: 'inv1', amountCents: 4000, collectorId: '9', method: 'bank_transfer', marketplaceFeeCents: 60 });
  });
});

describe('BillingService – fatura paga pelo Mercado Pago', () => {
  const ID = new Types.ObjectId().toHexString();
  const ENT = new Types.ObjectId();
  const mk = (invoice: any, pay?: any) => {
    const invoiceModel: any = {
      findById: jest.fn().mockResolvedValue(invoice),
      findOneAndUpdate: jest.fn().mockResolvedValue(invoice && invoice.status === 'pending' ? invoice : null),
    };
    const eventModel = { create: jest.fn().mockResolvedValue({}) };
    const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: jest.fn() };
    const connection = { startSession: jest.fn().mockResolvedValue(session) };
    const ent = { addDebt: jest.fn(), setBlocked: jest.fn() } as any;
    const mp = { platformToken: 'APP_USR-balcao', payment: jest.fn().mockResolvedValue(pay), verifySignature: jest.fn(() => true) } as any;
    const svc = new BillingService({} as any, invoiceModel, eventModel as any, connection as any, ent, mp, { get: () => undefined } as any, { policy: async () => ({ capCents: 4000, trialDays: 30 }) } as any);
    jest.spyOn(svc as any, 'refreshBlockStatus').mockResolvedValue(undefined);
    return { svc, mp, invoiceModel, ent, eventModel };
  };
  const inv = (o: object = {}) => ({ _id: new Types.ObjectId(ID), enterpriseId: ENT, amountCents: 1000, status: 'pending', ...o });
  const paid = (o: object = {}) => ({ id: '555', status: 'approved', externalReference: ID, amountCents: 1000, method: 'bank_transfer', ...o });
  const hook = (svc: BillingService, s: string, pid = '555') => svc.handleMercadoPagoWebhook({ i: ID, s, type: 'payment', 'data.id': pid }, { type: 'payment', data: { id: pid } });

  it('token inválido → 401 e nunca consulta o Mercado Pago', async () => {
    const { svc, mp } = mk(inv());
    await expect(hook(svc, 'errado')).rejects.toMatchObject({ status: 401 });
    expect(mp.payment).not.toHaveBeenCalled();
  });
  it('id malformado ou tópico que não é pagamento → ignora sem erro', async () => {
    const { svc } = mk(inv());
    await expect(svc.handleMercadoPagoWebhook({ i: { $ne: 1 } as any }, {})).resolves.toMatchObject({ outcome: 'invoice_not_found' });
    await expect(svc.handleMercadoPagoWebhook({ i: ID, s: sign('invoice', ID), topic: 'merchant_order', id: '1' }, {})).resolves.toMatchObject({ outcome: 'ignored' });
  });
  it('fatura já paga / cancelada', async () => {
    await expect(hook(mk(inv({ status: 'paid' })).svc, sign('invoice', ID))).resolves.toMatchObject({ outcome: 'already_paid' });
    await expect(hook(mk(inv({ status: 'cancelled' })).svc, sign('invoice', ID))).resolves.toMatchObject({ outcome: 'ignored' });
  });
  it('pagamento de outra fatura, pendente ou com valor menor não baixa', async () => {
    for (const [p, out] of [[paid({ externalReference: 'outra' }), 'not_this_invoice'], [paid({ status: 'pending' }), 'not_paid'], [paid({ amountCents: 999 }), 'amount_mismatch']] as const) {
      const { svc, invoiceModel } = mk(inv(), p);
      await expect(hook(svc, sign('invoice', ID))).resolves.toMatchObject({ outcome: out });
      expect(invoiceModel.findOneAndUpdate).not.toHaveBeenCalled();
    }
  });
  it('aprovado → baixa a fatura, abate a dívida e guarda o pagamento', async () => {
    const { svc, ent, invoiceModel, mp, eventModel } = mk(inv(), paid());
    await expect(hook(svc, sign('invoice', ID))).resolves.toMatchObject({ outcome: 'applied' });
    expect(mp.payment).toHaveBeenCalledWith('555', 'APP_USR-balcao');
    expect(ent.addDebt).toHaveBeenCalledWith(String(ENT), -1000, expect.anything());
    expect(invoiceModel.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ status: 'paid', paidVia: 'mercadopago', paymentId: '555', paymentMethod: 'bank_transfer' });
    expect(eventModel.create).toHaveBeenCalledWith(expect.objectContaining({ paymentId: '555', outcome: 'applied' }));
  });
  it('assinatura x-signature inválida → 401', async () => {
    const { svc, mp } = mk(inv(), paid());
    mp.verifySignature.mockReturnValue(false);
    await expect(svc.handleMercadoPagoWebhook({ i: ID, s: sign('invoice', ID), type: 'payment', 'data.id': '555' }, {}, { signature: 'ts=1,v1=x' })).rejects.toMatchObject({ status: 401 });
  });
  it('confirmação pela volta do checkout só vale para fatura da própria empresa', async () => {
    const { svc, invoiceModel } = mk(inv());
    invoiceModel.findOne = jest.fn().mockResolvedValue(null);
    await expect(svc.confirmFromRedirect('outra', ID, { paymentId: '555' })).rejects.toMatchObject({ status: 404 });
  });
});
