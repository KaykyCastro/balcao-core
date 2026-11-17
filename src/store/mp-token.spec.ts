import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { open, seal } from '../common/secret-box';
import { MercadoPagoClient, MpAuthError } from '../mercadopago/mercadopago.client';
import { SaleService } from '../sale/sale.service';
import { PosService } from '../pos/pos.service';
import { MpPollScheduler } from '../pos/mp-poll.scheduler';
import { checkTokenInput, feeCollectionOf, isFinalOutcome, marketplaceFeeFor, nextPollAt, pollDelayMs } from './mp-token.rules';
import { MpOrdersWebhookService } from './mp-orders-webhook.service';
import { MpPollService } from './mp-poll.service';
import { StoreService, tokenHash } from './store.service';

// Credenciais de exemplo no formato do Mercado Pago (inventadas; não valem em lugar nenhum).
const TOKEN = 'APP_USR-1234567890123456-111526-0f1e2d3c4b5a69788796a5b4c3d2e1f0-987654321';
const PUBLIC = 'APP_USR-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const ORD = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';

// ------------------------------------------------------------------ regras puras

describe('modo token: regras', () => {
  it('aceita credencial de produção e lê o user_id do fim do token', () => {
    expect(checkTokenInput({ accessToken: ` ${TOKEN}\n`, publicKey: PUBLIC })).toEqual({ ok: true, accessToken: TOKEN, publicKey: PUBLIC, userIdHint: '987654321' });
  });
  it('recusa credencial de teste com mensagem própria, e formatos que não são do Mercado Pago', () => {
    expect(checkTokenInput({ accessToken: 'TEST-1234567890123456-111526-abc-987654321', publicKey: PUBLIC })).toMatchObject({ ok: false, code: 'MP_TEST_CREDENTIALS' });
    expect(checkTokenInput({ accessToken: TOKEN, publicKey: 'TEST-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d' })).toMatchObject({ ok: false, code: 'MP_TEST_CREDENTIALS' });
    expect(checkTokenInput({ accessToken: 'minha-senha', publicKey: PUBLIC })).toMatchObject({ ok: false, code: 'MP_TOKEN_FORMAT' });
    expect(checkTokenInput({ accessToken: TOKEN, publicKey: '' })).toMatchObject({ ok: false, code: 'MP_PUBLIC_KEY_FORMAT' });
  });
  it('taxa: OAuth separa no pagamento (marketplace_fee); modo token vai para a fatura (sem marketplace_fee)', () => {
    expect(feeCollectionOf('oauth')).toBe('split');
    expect(feeCollectionOf(undefined)).toBe('split'); // lojas antigas, sem o campo
    expect(feeCollectionOf('token')).toBe('invoice');
    expect(marketplaceFeeFor('split', 285)).toBe(285);
    expect(marketplaceFeeFor('invoice', 285)).toBe(0);
  });
  it('consulta automática: 10 s no começo, mais espaçada depois, backoff em erro, para em 30 min', () => {
    expect(pollDelayMs(60_000, 0)).toBe(10_000);
    expect(pollDelayMs(10 * 60_000, 0)).toBe(20_000);
    expect(pollDelayMs(20 * 60_000, 0)).toBe(30_000);
    expect(pollDelayMs(60_000, 2)).toBe(40_000);
    expect(pollDelayMs(20 * 60_000, 9)).toBe(120_000);
    const t0 = new Date('2026-11-16T12:00:00Z');
    expect(nextPollAt(t0, new Date(t0.getTime() + 29 * 60_000), 0)).not.toBeNull();
    expect(nextPollAt(t0, new Date(t0.getTime() + 30 * 60_000), 0)).toBeNull();
    expect(isFinalOutcome('applied')).toBe(true);
    expect(isFinalOutcome('pending')).toBe(false);
    expect(isFinalOutcome('error')).toBe(false);
  });
});

// ------------------------------------------------------------------ conexão (StoreService)

function storeSvc(over: { me?: () => Promise<any>; otherStore?: boolean; doc?: any } = {}) {
  const sid = new Types.ObjectId(), eid = new Types.ObjectId();
  let doc: any = over.doc ?? { _id: sid, enterpriseId: eid, mp: { userId: '' } };
  const asDoc = (d: any) => Object.assign({}, d, { _id: sid, enterpriseId: eid, toJSON: () => JSON.parse(JSON.stringify(doc)) });
  const set = (u: any) => { for (const [k, v] of Object.entries(u.$set ?? {})) { if (k.includes('.')) { const [a, b] = k.split('.'); doc[a] = { ...doc[a], [b]: v }; } else doc[k] = v; } };
  const stores: any = {
    findOne: jest.fn(() => ({ ...Promise.resolve(asDoc(doc)), then: (r: any) => Promise.resolve(asDoc(doc)).then(r), select: () => ({ lean: async () => doc }) })),
    findById: jest.fn(() => ({ select: () => ({ lean: async () => doc }) })),
    updateOne: jest.fn(async (_q: any, u: any) => { set(u); return {}; }),
    exists: jest.fn(async () => (over.otherStore ? { _id: new Types.ObjectId() } : null)),
    findOneAndUpdate: jest.fn((q: any, u: any) => ({ lean: async () => {
      if (doc.mp?.tokenHash !== q['mp.tokenHash'] || doc.mp?.mode !== 'token' || doc.mp?.status === 'invalid') return null;
      set(u); return { _id: sid, enterpriseId: eid };
    } })),
  };
  const listeners: ((t: string) => void)[] = [];
  const mp: any = { me: jest.fn(over.me ?? (async () => ({ id: '987654321', nickname: 'LOJA_TESTE', email: 'loja@exemplo.com' }))), refresh: jest.fn(), onAuthError: (fn: any) => listeners.push(fn) };
  const settings: any = { policy: async () => ({ onlineRateBps: 150, directoryRateBps: 300 }) };
  const enterprises: any = { findEnterpriseById: async () => ({}) };
  const messages: any = { notify: jest.fn(async () => undefined) };
  const svc = new StoreService(stores, enterprises, {} as never, {} as never, {} as never, settings, mp, {} as never, undefined, messages);
  // getOrCreate busca a loja da empresa: devolve sempre a mesma.
  (svc as any).getOrCreate = async () => asDoc(doc);
  return { svc, stores, mp, messages, sid, eid, get doc() { return doc; }, fire401: (t: string) => listeners.forEach((f) => f(t)) };
}

describe('modo token: conexão da conta', () => {
  it('token válido: confere em /users/me e guarda cifrado; a resposta nunca traz o token', async () => {
    const t = storeSvc();
    const view = await t.svc.mpConnectToken(String(t.eid), { accessToken: TOKEN, publicKey: PUBLIC });
    expect(t.mp.me).toHaveBeenCalledWith(TOKEN);
    expect(t.doc.mp).toMatchObject({ mode: 'token', status: 'ok', userId: '987654321', nickname: 'LOJA_TESTE', publicKey: PUBLIC, refreshSealed: null, expiresAt: null });
    expect(t.doc.mp.accessSealed).not.toContain(TOKEN.slice(10));
    expect(open(t.doc.mp.accessSealed)).toBe(TOKEN);
    const json = JSON.stringify(view);
    expect(json).not.toContain(TOKEN.slice(10));
    expect(json).not.toContain('accessSealed');
    expect(json).not.toContain('tokenHash');
    expect(view.mp).toMatchObject({ mode: 'token', connected: true, webhookUrl: expect.stringContaining(`/public/mercadopago/webhook/loja/${t.sid}?s=`) });
  });

  it('TEST- recusado antes de chamar o Mercado Pago', async () => {
    const t = storeSvc();
    await expect(t.svc.mpConnectToken(String(t.eid), { accessToken: 'TEST-1234567890123456-111526-abcdef-987654321', publicKey: PUBLIC })).rejects.toMatchObject({ response: { code: 'MP_TEST_CREDENTIALS' } });
    expect(t.mp.me).not.toHaveBeenCalled();
    expect(t.stores.updateOne).not.toHaveBeenCalled();
  });

  it('token que o Mercado Pago recusa, ou de outra conta: erro claro e nada salvo', async () => {
    const t = storeSvc({ me: async () => { throw new MpAuthError('401'); } });
    await expect(t.svc.mpConnectToken(String(t.eid), { accessToken: TOKEN, publicKey: PUBLIC })).rejects.toMatchObject({ response: { code: 'MP_TOKEN_REJECTED' } });
    const t2 = storeSvc({ me: async () => ({ id: '111', nickname: '', email: '' }) }); // /users/me de outra conta
    await expect(t2.svc.mpConnectToken(String(t2.eid), { accessToken: TOKEN, publicKey: PUBLIC })).rejects.toMatchObject({ response: { code: 'MP_TOKEN_REJECTED' } });
    const t3 = storeSvc({ otherStore: true });
    await expect(t3.svc.mpConnectToken(String(t3.eid), { accessToken: TOKEN, publicKey: PUBLIC })).rejects.toMatchObject({ response: { code: 'MP_ACCOUNT_IN_USE' } });
    expect([t.stores, t2.stores, t3.stores].every((s) => s.updateOne.mock.calls.length === 0)).toBe(true);
  });

  it('mpAccessToken: modo token devolve o token colado e nunca tenta refresh', async () => {
    const t = storeSvc({ doc: { mp: { userId: '987654321', mode: 'token', status: 'ok', accessSealed: seal(TOKEN), refreshSealed: null, expiresAt: null } } });
    expect(await t.svc.mpAccessToken(new Types.ObjectId())).toBe(TOKEN);
    expect(t.mp.refresh).not.toHaveBeenCalled();
  });

  it('mpAccessToken: OAuth perto de vencer continua renovando sozinho', async () => {
    const t = storeSvc({ doc: { _id: new Types.ObjectId(), mp: { userId: '1', accessSealed: seal('APP_USR-old'), refreshSealed: seal('TG-refresh'), expiresAt: new Date(Date.now() + 86_400_000) } } });
    t.mp.refresh.mockResolvedValue({ accessToken: 'APP_USR-new', refreshToken: 'TG-new', expiresAt: new Date(Date.now() + 180 * 86_400_000) });
    expect(await t.svc.mpAccessToken(new Types.ObjectId())).toBe('APP_USR-new');
    expect(t.mp.refresh).toHaveBeenCalledWith('TG-refresh');
  });

  it('401 depois de conectado: marca inválida (sem apagar), avisa uma vez e passa a pedir token novo', async () => {
    const t = storeSvc({ doc: { mp: { userId: '987654321', mode: 'token', status: 'ok', accessSealed: seal(TOKEN), tokenHash: tokenHash(TOKEN) } } });
    t.fire401(TOKEN);
    await new Promise((r) => setImmediate(r));
    expect(t.doc.mp).toMatchObject({ status: 'invalid', userId: '987654321', invalidAt: expect.any(Date) });
    expect(open(t.doc.mp.accessSealed)).toBe(TOKEN); // dados ficam
    expect(t.messages.notify).toHaveBeenCalledTimes(1);
    t.fire401(TOKEN); await new Promise((r) => setImmediate(r));
    expect(t.messages.notify).toHaveBeenCalledTimes(1);
    await expect(t.svc.mpAccessToken(new Types.ObjectId())).rejects.toMatchObject({ response: { code: 'MP_TOKEN_INVALID' } });
  });
});

// ------------------------------------------------------------------ cliente do Mercado Pago

describe('modo token: cliente do Mercado Pago', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  afterEach(() => { (global as any).fetch = undefined; });

  it('ordem de Checkout Pro sem comissão não leva marketplace_fee', async () => {
    const bodies: any[] = [];
    global.fetch = jest.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return json({ id: ORD, checkout_url: 'https://www.mercadopago.com.br/checkout/x' }); }) as any;
    const mp = new MercadoPagoClient(new ConfigService({}));
    await mp.createPreference({ accessToken: TOKEN, orderId: 'abc', items: [{ title: 'Vestido', quantity: 1, unitCents: 18990 }], marketplaceFeeCents: 0, payer: { name: 'Ana Souza', email: 'ana@ex.com' }, backUrl: 'https://loja.exemplo/pedido' });
    expect(bodies[0]).not.toHaveProperty('marketplace_fee');
    await mp.createPreference({ accessToken: TOKEN, orderId: 'abd', items: [{ title: 'Vestido', quantity: 1, unitCents: 18990 }], marketplaceFeeCents: 285, payer: { name: 'Ana Souza', email: 'ana@ex.com' }, backUrl: 'https://loja.exemplo/pedido' });
    expect(bodies[1].marketplace_fee).toBe('2.85');
  });

  it('401 em qualquer chamada avisa quem escuta (com o token, para achar a loja) e vira MpAuthError', async () => {
    global.fetch = jest.fn(async () => json({ message: 'invalid access token' }, 401)) as any;
    const mp = new MercadoPagoClient(new ConfigService({}));
    const seen: string[] = [];
    mp.onAuthError((t) => seen.push(t));
    await expect(mp.terminals(TOKEN)).rejects.toBeInstanceOf(MpAuthError);
    expect(seen).toEqual([TOKEN]);
  });
});

// ------------------------------------------------------------------ taxa na fatura (SaleService)

describe('modo token: taxa da loja online na fatura', () => {
  it('venda online paga: OAuth só registra a taxa separada; modo token lança na fatura (dívida)', async () => {
    const billing: any = { recordCollectedFee: jest.fn(async (_e, _s, _b, _r, fee) => fee), recordUncollectedOnlineFee: jest.fn(async () => 285) };
    const saleModel: any = { create: jest.fn(async ([d]) => [d]) };
    const svc = new SaleService(saleModel, {} as never, {} as never, {} as never, billing, {} as never);
    const base = { orderId: new Types.ObjectId(), items: [], totalCents: 18990, rateBps: 150, collectedFeeCents: 0 };
    const split = await svc.recordOnlineSale('e1', { ...base, collectedFeeCents: 285 }, {} as never);
    expect(billing.recordCollectedFee).toHaveBeenCalledTimes(1);
    expect(split.feeCents).toBe(285);
    const inv = await svc.recordOnlineSale('e1', { ...base, feeCollection: 'invoice' }, {} as never);
    expect(billing.recordUncollectedOnlineFee).toHaveBeenCalledWith('e1', inv._id, 18990, 150, {});
    expect(inv.feeCents).toBe(285);
  });
});

// ------------------------------------------------------------------ aviso da loja (webhook por loja)

function hookSvc(pay: any) {
  const storeId = new Types.ObjectId(), eid = new Types.ObjectId(), ref = new Types.ObjectId();
  const mp: any = { payment: jest.fn(async () => ({ ...pay, externalReference: pay.externalReference ?? String(ref) })), verifySignature: jest.fn(() => false) };
  const stores: any = { mpAccessToken: jest.fn(async () => TOKEN) };
  const orders: any = { syncPayment: jest.fn(async () => 'applied') };
  const tabs: any = { syncPayment: jest.fn(async () => 'applied') };
  const q = (v: any) => ({ select: () => ({ lean: async () => v }) });
  const storeModel: any = { findOne: jest.fn(() => q({ _id: storeId, enterpriseId: eid, mp: { userId: '987654321' } })) };
  const orderModel: any = { findOne: jest.fn(async () => ({ _id: ref })) };
  const tabModel: any = { findOne: jest.fn(async () => null) };
  const svc = new MpOrdersWebhookService(mp, {} as never, {} as never, orders, tabs, stores, {} as never, storeModel, orderModel, tabModel);
  const real = new StoreService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { onAuthError() {} } as never, {} as never).mpWebhookUrl(String(storeId));
  const url = (s?: string) => ({ s: s ?? /[?&]s=([^&]+)/.exec(real)![1] });
  return { svc, mp, stores, orders, storeId, eid, ref, url };
}

describe('modo token: aviso no endereço da loja', () => {
  const body = { type: 'order', action: 'order.processed', user_id: '987654321', data: { id: ORD } };

  it('URL sem a assinatura da loja: recusado sem consultar nada', async () => {
    const t = hookSvc({ id: ORD, status: 'approved' });
    await expect(t.svc.handleStore(String(t.storeId), t.url('falsa'), body)).rejects.toMatchObject({ status: 401 });
    expect(t.mp.payment).not.toHaveBeenCalled();
  });

  it('não confere x-signature (não temos o segredo da aplicação do lojista): consulta a ordem com o token da loja', async () => {
    const t = hookSvc({ id: ORD, status: 'approved' });
    const r = await t.svc.handleStore(String(t.storeId), t.url(), body);
    expect(r.outcome).toBe('applied');
    expect(t.mp.verifySignature).not.toHaveBeenCalled();
    expect(t.mp.payment).toHaveBeenCalledWith(ORD, TOKEN);
    expect(t.orders.syncPayment).toHaveBeenCalledWith({ _id: t.ref }, ORD); // só o id segue; o corpo não decide nada
  });

  it('aviso de outra conta (URL colada na aplicação errada): ignorado sem consultar', async () => {
    const t = hookSvc({ id: ORD, status: 'approved' });
    expect((await t.svc.handleStore(String(t.storeId), t.url(), { ...body, user_id: '1' })).outcome).toBe('other_account');
    expect(t.mp.payment).not.toHaveBeenCalled();
  });

  it('cobrança do caixa (referência balcao-<id>): segue para o caixa registrado', async () => {
    const pos = new Types.ObjectId();
    const t = hookSvc({ id: ORD, status: 'approved', externalReference: `balcao-${pos}` });
    const sync = jest.fn(async () => 'paid');
    t.svc.registerPos(sync);
    expect((await t.svc.handleStore(String(t.storeId), t.url(), body)).outcome).toBe('paid');
    expect(sync).toHaveBeenCalledWith(String(t.eid), String(pos));
  });
});

// ------------------------------------------------------------------ caixa: Pix e Point (aviso + consulta)

function posSetup() {
  const EID = String(new Types.ObjectId());
  const docs = new Map<string, any>();
  const asDoc = (d: any) => Object.assign(d, { toObject: () => d });
  const configs: any = { findOne: () => ({ select() { return this; }, lean: async () => ({ pix: { mode: 'mercadopago' }, point: { enabled: true, terminalId: 'PAX_A910__SMARTPOS123' } }) }), updateOne: jest.fn(async () => ({})) };
  const match = (d: any, q: any) => Object.entries(q).every(([k, v]: any) => (k === '_id' ? String(d._id) === String(v) : k === 'enterpriseId' ? String(d.enterpriseId) === String(v) : k === 'status' ? (v?.$in ? v.$in.includes(d.status) : d.status === v) : true));
  const payments: any = {
    findOne: jest.fn(async (q: any) => [...docs.values()].find((d) => match(d, q)) ?? null),
    findById: jest.fn(async (id: any) => docs.get(String(id)) ?? null),
    create: jest.fn(async (d: any) => { const doc = asDoc({ status: 'pending', saleId: null, detail: null, paidAt: null, ...d }); docs.set(String(d._id), doc); return doc; }),
    updateOne: jest.fn(async (q: any, u: any) => { const d = docs.get(String(q._id)); if (d && match(d, q)) Object.assign(d, u.$set); return {}; }),
    findOneAndUpdate: jest.fn(async (q: any, u: any) => { const d = docs.get(String(q._id)); if (!d || !match(d, q)) return null; Object.assign(d, u.$set); return d; }),
  };
  let state = 'pending';
  const mp: any = {
    createPixOrder: jest.fn(async () => ({ id: ORD, state: 'pending', qrCode: '000201', qrBase64: 'iVBOR' })),
    order: jest.fn(async () => ({ id: ORD, state, status: state === 'paid' ? 'processed' : 'created', statusDetail: '', paymentId: 'PAY-1', method: 'pix', installments: 1, methodType: 'bank_transfer' })),
  };
  // Como no banco: a venda tem índice único por (loja, chave de idempotência); a segunda transação com a mesma chave
  // é desfeita (estoque e taxa juntos) e devolve a venda que já existe (SaleService.create).
  const created = new Map<string, any>();
  const sales: any = { quote: jest.fn(async () => ({ totalCents: 1990 })), created, create: jest.fn(async (_e: string, _d: unknown, key: string) => { if (!created.has(key)) created.set(key, { _id: new Types.ObjectId(), totalCents: 1990 }); return created.get(key); }), findById: jest.fn(async () => null) };
  const stores: any = { getOrCreate: jest.fn(async () => ({ _id: new Types.ObjectId(), mp: { userId: '987654321', mode: 'token' } })), mpAccessToken: jest.fn(async () => TOKEN), mpMode: jest.fn(async () => 'token') };
  const polls: any = { track: jest.fn(async () => undefined), lease: jest.fn(async (_k: string, _id: unknown, fn: () => Promise<string>) => fn()) };
  const hooks: any = { registerPos: jest.fn() };
  const svc = new PosService(configs, payments, mp, { partnerReady: false } as never, sales, stores, { findEnterpriseById: async () => ({ name: 'Padaria' }) } as never, { getCustomerById: async () => ({}) } as never, {} as never, polls, hooks);
  return { svc, EID, mp, sales, polls, hooks, docs, pay: () => { state = 'paid'; } };
}

describe('modo token: Pix e Point do caixa', () => {
  it('cobrança criada com o token da loja entra na consulta automática; o caixa se registra no webhook', async () => {
    const t = posSetup();
    const c = await t.svc.charge(t.EID, { method: 'pix', provider: 'mp_pix', items: [{ productId: String(new Types.ObjectId()), quantity: 1 }] });
    expect(t.mp.createPixOrder.mock.calls[0][0]).toMatchObject({ accessToken: TOKEN, amountCents: 1990 });
    expect(t.polls.track).toHaveBeenCalledWith('pos', expect.anything(), expect.anything(), expect.any(Date));
    expect(t.hooks.registerPos).toHaveBeenCalled();
    expect(c.status).toBe('pending');
  });

  it('aviso e consulta automática ao mesmo tempo: uma venda só (chave pos:<id>)', async () => {
    const t = posSetup();
    const c = await t.svc.charge(t.EID, { method: 'pix', provider: 'mp_pix', items: [{ productId: String(new Types.ObjectId()), quantity: 1 }] });
    expect(await t.svc.syncById(t.EID, c.id)).toBe('pending');
    t.pay();
    const out = await Promise.all([t.svc.syncById(t.EID, c.id), t.svc.syncById(t.EID, c.id), t.svc.status(t.EID, c.id)]);
    expect(out[0]).toBe('paid');
    expect(t.sales.created.size).toBe(1); // uma venda só, com a chave pos:<id>
    expect([...t.sales.created.keys()]).toEqual([`pos:${c.id}`]);
    expect(t.sales.create.mock.calls.every((call: unknown[]) => call[2] === `pos:${c.id}`)).toBe(true);
    expect(String(t.docs.get(c.id).saleId)).toBe(String([...t.sales.created.values()][0]._id));
  });
});

// ------------------------------------------------------------------ vez de consultar (MpPollService) e rotina

function pollModel() {
  const rows: any[] = [];
  const hit = (r: any, q: any) => Object.entries(q).every(([k, v]: any) => {
    if (k === '$or') return v.some((alt: any) => hit(r, alt));
    if (k === 'refId') return String(r.refId) === String(v);
    if (v === null) return r[k] == null;
    if (v?.$lte) return r[k] && r[k] <= v.$lte;
    return r[k] === v;
  });
  const lean = (v: any) => ({ lean: async () => v, sort() { return this; }, limit() { return this; } });
  return {
    rows,
    updateOne: jest.fn(async (q: any, u: any, o: any) => { let r = rows.find((x) => hit(x, q)); if (!r && o?.upsert) { r = { ...q, ...u.$setOnInsert }; rows.push(r); } else if (r) Object.assign(r, u.$set); return {}; }),
    findOneAndUpdate: jest.fn((q: any, u: any) => { const r = rows.find((x) => hit(x, q)); if (r) Object.assign(r, u.$set); return lean(r ? { ...r } : null); }),
    exists: jest.fn(async (q: any) => rows.find((x) => hit(x, q)) ?? null),
    deleteOne: jest.fn(async (q: any) => { const i = rows.findIndex((x) => hit(x, q)); if (i >= 0) rows.splice(i, 1); }),
    find: jest.fn((q: any) => lean(rows.filter((x) => hit(x, q)))),
  };
}

describe('modo token: vez de consultar e rotina de 10 s', () => {
  it('a mesma cobrança não é consultada em paralelo; quem não pega a vez pula', async () => {
    const m = pollModel(); const polls = new MpPollService(m as never);
    const id = new Types.ObjectId();
    await polls.track('pos', id, new Types.ObjectId(), new Date());
    let release!: () => void;
    const slow = polls.lease('pos', id, () => new Promise<string>((r) => { release = () => r('pending'); }));
    await new Promise((r) => setImmediate(r));
    expect(await polls.lease('pos', id, async () => 'paid')).toBe('skipped');
    release(); expect(await slow).toBe('pending');
    expect(await polls.lease('pos', id, async () => 'paid')).toBe('paid');
    expect(m.rows).toHaveLength(0); // resolvido: sai da fila
  });

  it('cobrança não acompanhada (OAuth): roda direto, sem fila', async () => {
    const polls = new MpPollService(pollModel() as never);
    expect(await polls.lease('order', new Types.ObjectId(), async () => 'applied')).toBe('applied');
  });

  it('rotina: confere o que está na vez, reagenda o pendente, tira o resolvido, espaça no erro e para no token recusado', async () => {
    const m = pollModel(); const polls = new MpPollService(m as never);
    const past = new Date(Date.now() - 60_000);
    const ids = { pending: new Types.ObjectId(), paid: new Types.ObjectId(), err: new Types.ObjectId(), auth: new Types.ObjectId() };
    for (const [k, id] of Object.entries(ids)) m.rows.push({ kind: k === 'paid' ? 'order' : 'pos', refId: id, enterpriseId: new Types.ObjectId(), startedAt: past, next: past, fails: 0, lockUntil: null });
    const pos: any = { syncById: jest.fn(async (_e: string, id: string) => {
      if (id === String(ids.err)) throw new Error('Mercado Pago 429');
      if (id === String(ids.auth)) throw new MpAuthError('401');
      return 'pending';
    }) };
    const orders: any = { pollOnce: jest.fn(async () => 'applied') };
    const sched = new MpPollScheduler(polls, pos, orders, {} as never);
    expect(await sched.round()).toBe(1);
    const left = (id: Types.ObjectId) => m.rows.find((r) => String(r.refId) === String(id));
    expect(left(ids.paid)).toBeUndefined();
    expect(left(ids.auth)).toBeUndefined();
    expect(left(ids.pending)).toMatchObject({ fails: 0, lockUntil: null });
    expect(left(ids.pending).next.getTime()).toBeGreaterThan(Date.now());
    expect(left(ids.err)).toMatchObject({ fails: 1, lockUntil: null });
    expect(left(ids.err).next.getTime() - Date.now()).toBeGreaterThan(left(ids.pending).next.getTime() - Date.now());
  });
});
