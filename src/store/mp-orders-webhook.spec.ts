import { Types } from 'mongoose';
import { MpOrdersWebhookService } from './mp-orders-webhook.service';

const ORD = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
function make(opts: { sigOk?: boolean; ref?: string; store?: any; order?: any; tab?: any } = {}) {
  const ref = opts.ref ?? new Types.ObjectId().toHexString();
  const mp: any = {
    platformToken: 'PLAT', me: jest.fn(async () => ({ id: '111' })),
    verifySignature: jest.fn(() => opts.sigOk ?? true),
    payment: jest.fn(async () => ({ id: ORD, status: 'approved', externalReference: ref })),
  };
  const billing: any = { confirm: jest.fn(async () => 'applied') };
  const orders: any = { syncPayment: jest.fn(async () => 'applied') };
  const tabs: any = { syncPayment: jest.fn(async () => 'applied') };
  const stores: any = { mpAccessToken: jest.fn(async () => 'LOJA') };
  const q = (v: any) => ({ select: () => ({ lean: async () => v }) });
  const storeModel: any = { findOne: jest.fn(() => q(opts.store ?? null)) };
  const orderModel: any = { findOne: jest.fn(async () => opts.order ?? null) };
  const tabModel: any = { findOne: jest.fn(async () => opts.tab ?? null) };
  const autopay: any = { webhook: jest.fn(async () => ({ received: true, outcome: 'synced' })) };
  const svc = new MpOrdersWebhookService(mp, billing, autopay, orders, tabs, stores, storeModel, orderModel, tabModel);
  return { svc, mp, billing, orders, tabs, stores, autopay, ref };
}
const body = (user: string) => ({ type: 'order', action: 'order.processed', user_id: user, data: { id: ORD } });

describe('webhook único das ordens (Checkout Pro via Orders)', () => {
  it('conta do Balcão: confirma a fatura pela referência da ordem, consultada com o token da plataforma', async () => {
    const t = make();
    const r = await t.svc.handle({}, body('111'), { signature: 'x', requestId: 'r' });
    expect(r.outcome).toBe('applied');
    expect(t.mp.payment).toHaveBeenCalledWith(ORD, 'PLAT');
    expect(t.billing.confirm).toHaveBeenCalledWith(t.ref, ORD);
  });

  it('conta de lojista: acha a loja pelo user_id, consulta com o token dela e confirma o pedido', async () => {
    const store = { _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId() };
    const t = make({ store, order: { _id: 'o' } });
    expect((await t.svc.handle({}, body('222'), {})).outcome).toBe('applied');
    expect(t.stores.mpAccessToken).toHaveBeenCalledWith(store._id);
    expect(t.mp.payment).toHaveBeenCalledWith(ORD, 'LOJA');
    expect(t.orders.syncPayment).toHaveBeenCalled();
    expect(t.tabs.syncPayment).not.toHaveBeenCalled();
  });

  it('sem pedido com essa referência na loja: tenta a comanda', async () => {
    const t = make({ store: { _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId() }, tab: { _id: 't' } });
    expect((await t.svc.handle({}, body('222'), {})).outcome).toBe('applied');
    expect(t.tabs.syncPayment).toHaveBeenCalled();
  });

  it('avisos da assinatura no cartão seguem para o tratamento da cobrança automática', async () => {
    const t = make();
    expect((await t.svc.handle({}, { type: 'subscription_preapproval', data: { id: 'pre1' } }, {})).outcome).toBe('synced');
    expect(t.autopay.webhook).toHaveBeenCalled();
  });

  it('assinatura inválida é recusada; conta desconhecida e aviso que não é de ordem são ignorados', async () => {
    await expect(make({ sigOk: false }).svc.handle({}, body('111'), { signature: 'x' })).rejects.toThrow('Assinatura inválida');
    expect((await make().svc.handle({}, body('999'), {})).outcome).toBe('store_not_found');
    expect((await make().svc.handle({}, { type: 'payment', data: { id: '123' } }, {})).outcome).toBe('ignored');
  });
});
