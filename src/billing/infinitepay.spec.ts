import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { InfinitePayClient } from './infinitepay.client';
import { BillingService } from './billing.service';

const cfg = (o: Record<string, string> = {}) =>
  ({ get: (k: string) => ({ INFINITEPAY_HANDLE: '$minha_tag', INFINITEPAY_WEBHOOK_SECRET: 's3cret-s3cret', ...o })[k] }) as unknown as ConfigService;
const okJson = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

describe('InfinitePayClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('token do webhook: válido só para a própria fatura e com o mesmo segredo', () => {
    const c = new InfinitePayClient(cfg());
    const t = c.webhookToken('a'.repeat(24));
    expect(t).toHaveLength(40);
    expect(c.verifyWebhookToken('a'.repeat(24), t)).toBe(true);
    expect(c.verifyWebhookToken('b'.repeat(24), t)).toBe(false);
    expect(c.verifyWebhookToken('a'.repeat(24), 'x'.repeat(40))).toBe(false);
    expect(c.verifyWebhookToken('a'.repeat(24), undefined)).toBe(false);
    expect(c.verifyWebhookToken('a'.repeat(24), ['x'])).toBe(false);
    expect(new InfinitePayClient(cfg({ INFINITEPAY_WEBHOOK_SECRET: 'outro-segredo-12' })).verifyWebhookToken('a'.repeat(24), t)).toBe(false);
  });

  it('cria link com handle sem "$", valor em centavos e aceita checkout_url ou link', async () => {
    const f = jest.spyOn(global, 'fetch').mockImplementation(() => okJson({ checkout_url: 'https://checkout.infinitepay.io/x', slug: 'abc' }));
    const r = await new InfinitePayClient(cfg()).createCheckoutLink({ orderNsu: 'o1', amountCents: 1234, description: 'Taxa', redirectUrl: 'https://app/x', webhookUrl: 'https://api/w?s=1' });
    expect(r).toEqual({ url: 'https://checkout.infinitepay.io/x', slug: 'abc' });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ handle: 'minha_tag', order_nsu: 'o1', items: [{ quantity: 1, price: 1234 }], webhook_url: 'https://api/w?s=1' });
    f.mockImplementation(() => okJson({ link: 'https://pay.example/y' }));
    expect((await new InfinitePayClient(cfg()).createCheckoutLink({ orderNsu: 'o', amountCents: 1, description: 'd' })).url).toBe('https://pay.example/y');
  });

  it('rejeita link não-https, erro HTTP e falha de rede', async () => {
    const c = new InfinitePayClient(cfg());
    const f = jest.spyOn(global, 'fetch');
    f.mockImplementation(() => okJson({ checkout_url: 'javascript:alert(1)' }));
    await expect(c.createCheckoutLink({ orderNsu: 'o', amountCents: 1, description: 'd' })).rejects.toMatchObject({ status: 502 });
    f.mockImplementation(() => okJson({}, 500));
    await expect(c.createCheckoutLink({ orderNsu: 'o', amountCents: 1, description: 'd' })).rejects.toMatchObject({ status: 502 });
    f.mockRejectedValue(new Error('boom'));
    await expect(c.paymentCheck({ orderNsu: 'o', transactionNsu: 't', slug: 's' })).rejects.toMatchObject({ status: 502 });
  });

  it('sem InfinitePay configurado: 503', async () => {
    await expect(new InfinitePayClient(cfg({ INFINITEPAY_HANDLE: '' })).createCheckoutLink({ orderNsu: 'o', amountCents: 1, description: 'd' })).rejects.toMatchObject({ status: 503 });
  });

  it('payment_check só considera pago com paid === true', async () => {
    const f = jest.spyOn(global, 'fetch');
    f.mockImplementation(() => okJson({ paid: true, amount: 500, paid_amount: 500, capture_method: 'pix' }));
    expect(await new InfinitePayClient(cfg()).paymentCheck({ orderNsu: 'o', transactionNsu: 't', slug: 's' })).toMatchObject({ paid: true, amountCents: 500, paidAmountCents: 500, captureMethod: 'pix' });
    f.mockImplementation(() => okJson({ paid: 'true' }));
    expect((await new InfinitePayClient(cfg()).paymentCheck({ orderNsu: 'o', transactionNsu: 't', slug: 's' })).paid).toBe(false);
  });
});

describe('BillingService – confirmação de pagamento', () => {
  const ID = new Types.ObjectId().toHexString();
  const ENT = new Types.ObjectId();
  const mk = (invoice: any, check?: any) => {
    const invoiceModel: any = {
      findById: jest.fn().mockResolvedValue(invoice),
      findOneAndUpdate: jest.fn().mockResolvedValue(invoice && invoice.status === 'pending' ? invoice : null),
    };
    const eventModel = { create: jest.fn().mockResolvedValue({}) };
    const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: jest.fn() };
    const connection = { startSession: jest.fn().mockResolvedValue(session) };
    const ent = { addDebt: jest.fn(), setBlocked: jest.fn(), findByIdLean: jest.fn() } as any;
    const pay = { verifyWebhookToken: jest.fn((_o: string, t: unknown) => t === 'ok'), paymentCheck: jest.fn().mockResolvedValue(check) } as any;
    const svc = new BillingService({} as any, invoiceModel, eventModel as any, connection as any, ent, pay, { get: () => undefined } as any, { policy: async () => ({ capCents: 4000, trialDays: 30 }) } as any);
    jest.spyOn(svc as any, 'refreshBlockStatus').mockResolvedValue(undefined);
    return { svc, pay, invoiceModel, ent };
  };
  const inv = (o: object = {}) => ({ _id: new Types.ObjectId(ID), enterpriseId: ENT, amountCents: 1000, status: 'pending', ...o });
  const hook = (svc: BillingService, token: unknown, body: object) => svc.handleInfinitePayWebhook({ token, body: body as any });
  const full = { order_nsu: ID, transaction_nsu: 'tx', invoice_slug: 'sl' };

  it('token inválido → 401 e nunca consulta a InfinitePay', async () => {
    const { svc, pay } = mk(inv());
    await expect(hook(svc, 'errado', full)).rejects.toMatchObject({ status: 401 });
    expect(pay.paymentCheck).not.toHaveBeenCalled();
  });
  it('order_nsu malformado → invoice_not_found (sem erro 500)', async () => {
    const { svc } = mk(inv());
    await expect(hook(svc, 'ok', { order_nsu: { $ne: 1 } })).resolves.toMatchObject({ outcome: 'invoice_not_found' });
    await expect(hook(svc, 'ok', {})).resolves.toMatchObject({ outcome: 'invoice_not_found' });
  });
  it('fatura inexistente / já paga / cancelada', async () => {
    await expect(hook(mk(null).svc, 'ok', full)).resolves.toMatchObject({ outcome: 'invoice_not_found' });
    await expect(hook(mk(inv({ status: 'paid' })).svc, 'ok', full)).resolves.toMatchObject({ outcome: 'already_paid' });
    await expect(hook(mk(inv({ status: 'cancelled' })).svc, 'ok', full)).resolves.toMatchObject({ outcome: 'ignored' });
  });
  it('sem transaction_nsu/slug → unverifiable, sem baixar', async () => {
    const { svc, pay, invoiceModel } = mk(inv());
    await expect(hook(svc, 'ok', { order_nsu: ID })).resolves.toMatchObject({ outcome: 'unverifiable' });
    expect(pay.paymentCheck).not.toHaveBeenCalled();
    expect(invoiceModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('não pago na InfinitePay → not_paid', async () => {
    const { svc, invoiceModel } = mk(inv(), { paid: false });
    await expect(hook(svc, 'ok', full)).resolves.toMatchObject({ outcome: 'not_paid' });
    expect(invoiceModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('valor diferente (menor/maior que a fatura) → amount_mismatch', async () => {
    for (const c of [{ paid: true, amountCents: 1, paidAmountCents: 1 }, { paid: true, amountCents: 1000, paidAmountCents: 999 }, { paid: true, paidAmountCents: 1000 }]) {
      const { svc, invoiceModel } = mk(inv(), c);
      await expect(hook(svc, 'ok', full)).resolves.toMatchObject({ outcome: 'amount_mismatch' });
      expect(invoiceModel.findOneAndUpdate).not.toHaveBeenCalled();
    }
  });
  it('pagamento válido → baixa a fatura e abate a dívida uma única vez', async () => {
    const { svc, ent, invoiceModel } = mk(inv(), { paid: true, amountCents: 1000, paidAmountCents: 1000, captureMethod: 'pix' });
    await expect(hook(svc, 'ok', full)).resolves.toMatchObject({ outcome: 'applied' });
    expect(ent.addDebt).toHaveBeenCalledWith(String(ENT), -1000, expect.anything());
    expect(invoiceModel.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: expect.anything(), status: 'pending' });
  });
  it('confirmação pelo redirect só vale para fatura da própria empresa', async () => {
    const { svc, invoiceModel } = mk(inv());
    (invoiceModel as any).findOne = jest.fn().mockResolvedValue(null);
    await expect(svc.confirmFromRedirect('outra', ID, { transactionNsu: 't', slug: 's' })).rejects.toMatchObject({ status: 404 });
  });
});
