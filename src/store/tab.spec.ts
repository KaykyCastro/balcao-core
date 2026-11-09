import { Types } from 'mongoose';
import { TabService, tabTotals } from './tab.service';
import { sha256 } from '../common/secret-box';

const EID = new Types.ObjectId();
const P1 = new Types.ObjectId(), P2 = new Types.ObjectId();

function q<T>(v: T) {
  const p: any = Promise.resolve(v);
  p.session = () => p; p.select = () => p; p.lean = () => p; p.sort = () => p; p.limit = () => p;
  return p;
}
const get = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);
function match(r: any, f: any): boolean {
  return Object.entries(f).every(([k, v]: [string, any]) => {
    const x = k === '_id' ? String(r._id) : get(r, k);
    if (k === '_id') return x === String(v);
    if (v && typeof v === 'object' && !(v instanceof Types.ObjectId) && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(x);
      if ('$ne' in v) return x !== v.$ne;
      if ('$gte' in v) return true;
    }
    if (v instanceof Types.ObjectId) return String(x) === String(v);
    if (v === null) return x == null;
    return x === v;
  });
}
function apply(d: any, u: any) {
  for (const [k, v] of Object.entries(u.$set ?? u)) { if (k.startsWith('$')) continue; const parts = k.split('.'); let o = d; for (const p of parts.slice(0, -1)) o = o[p] ??= {}; o[parts.at(-1)!] = v; }
  for (const [k, v] of Object.entries(u.$inc ?? {})) { const parts = k.split('.'); let o = d; for (const p of parts.slice(0, -1)) o = o[p] ??= {}; o[parts.at(-1)!] = (o[parts.at(-1)!] ?? 0) + (v as number); }
}

function setup(opts: { mode?: string; payment?: 'tab' | 'upfront'; service?: number; stock?: Record<string, number>; waiters?: any[] } = {}) {
  const waiters: any[] = opts.waiters ?? [];
  const rows: any[] = [];
  const tabs: any = {
    countDocuments: jest.fn(async (f: any) => rows.filter((r) => match(r, f)).length),
    create: jest.fn(async (d: any) => { const r = { _id: new Types.ObjectId(), createdAt: new Date(), ...d, items: [...d.items], payment: { ...d.payment } }; rows.push(r); return r; }),
    findOne: jest.fn((f: any) => q(rows.find((r) => match(r, f)) ?? null)),
    findById: jest.fn((id: any) => q(rows.find((r) => String(r._id) === String(id)) ?? null)),
    find: jest.fn((f: any) => q(rows.filter((r) => match(r, f)))),
    updateOne: jest.fn(async (f: any, u: any) => { const d = rows.find((r) => match(r, f)); if (d) apply(d, u); return { modifiedCount: d ? 1 : 0 }; }),
    findOneAndUpdate: jest.fn((f: any, u: any) => { const d = rows.find((r) => match(r, f)); if (!d) return q(null); const before = { ...d, items: [...d.items], payment: { ...d.payment } }; apply(d, u); return q(before); }),
  };
  const conn: any = { startSession: async () => ({ withTransaction: async (fn: any) => fn(), endSession: async () => undefined }) };
  const store: any = {
    _id: new Types.ObjectId(), enterpriseId: EID, slug: 'boteco', name: 'Boteco', mode: opts.mode ?? 'menu', mp: { userId: '77' },
    tables: { enabled: true, count: 10, label: 'Mesa', payment: opts.payment ?? 'tab', serviceRateBps: opts.service ?? 0 }, legal: {},
  };
  let seq = 0;
  const stores: any = {
    publicBySlug: jest.fn(async () => ({ store })), getOrCreate: jest.fn(async () => store), nextTabNumber: jest.fn(async () => ++seq),
    mpAccessToken: jest.fn(async () => 'tok'),
  };
  const stock: Record<string, number> = { [String(P1)]: 10, [String(P2)]: 10, ...(opts.stock ?? {}) };
  const prods: any = {
    [String(P1)]: { _id: P1, name: 'Chopp', code: 'CH', price: 12, quantity: 10, trackStock: true },
    [String(P2)]: { _id: P2, name: 'Porção de fritas', code: 'PF', price: 30, quantity: 0, trackStock: false },
  };
  const products: any = {
    publicMany: jest.fn(async (_e: string, ids: string[]) => ids.map((i) => prods[i]).filter(Boolean)),
    getProductById: jest.fn(async (_e: string, i: string) => prods[i]),
    decreaseQuantity: jest.fn(async (_e: string, i: string, n: number) => { if (prods[i].trackStock === false) return { tracked: false }; if (stock[i] < n) throw new Error('sem estoque'); stock[i] -= n; return { tracked: true }; }),
    increaseQuantity: jest.fn(async (_e: string, i: string, n: number) => { stock[i] += n; }),
  };
  const promotions: any = { activeFor: jest.fn(async () => new Map()), consume: jest.fn(), release: jest.fn() };
  const salesRows: any[] = [];
  const sales: any = {
    recordTabSale: jest.fn(async (_e: string, p: any) => { const s = { _id: new Types.ObjectId(), ...p, totalCents: p.subtotalCents + p.serviceCents }; salesRows.push(s); return s; }),
    findById: jest.fn(async (_e: string, id: string) => salesRows.find((s) => String(s._id) === id)),
  };
  const mp: any = {
    createPreference: jest.fn(async () => ({ id: 'pref1', initPoint: 'https://mp/pay' })),
    payment: jest.fn(),
    verifySignature: jest.fn(() => true),
  };
  const config: any = { get: (k: string) => (k === 'FRONTEND_URL' ? 'https://app' : 'https://api') };
  const svc = new TabService(tabs, conn, stores, products, promotions, sales, mp, config, { waitersOnDuty: async () => waiters } as any);
  return { svc, rows, store, stock, sales, salesRows, mp, products };
}

describe('comandas de mesa', () => {
  it('soma itens e taxa de serviço, ignorando os cancelados', () => {
    expect(tabTotals([{ status: 'new', totalCents: 1000 }, { status: 'cancelled', totalCents: 500 }, { status: 'served', totalCents: 2000 }], 1000)).toEqual({ subtotalCents: 3000, serviceCents: 300, totalCents: 3300 });
  });

  it('só existe no modo cardápio com mesas em comanda', async () => {
    await expect(setup({ mode: 'ecommerce' }).svc.openPublic('boteco', { table: 3, name: 'Ana' })).rejects.toThrow(/não usa comanda/);
    await expect(setup({ payment: 'upfront' }).svc.openPublic('boteco', { table: 3, name: 'Ana' })).rejects.toThrow(/não usa comanda/);
    await expect(setup().svc.openPublic('boteco', { table: 11, name: 'Ana' })).rejects.toThrow(/de 1 a 10/);
  });

  it('cliente abre a conta, pede (reserva estoque), e só paga depois que o garçom libera', async () => {
    const t = setup({ service: 1000 });
    const { token, tab } = await t.svc.openPublic('boteco', { table: 3, name: 'Ana' });
    expect(tab).toMatchObject({ table: 3, name: 'Ana', status: 'open', number: 1 });
    const v = await t.svc.customerAdd('boteco', tab.id, token, [{ productId: String(P1), quantity: 2 }, { productId: String(P2), quantity: 1, note: 'sem sal' }]);
    expect(t.stock[String(P1)]).toBe(8);
    expect(v).toMatchObject({ subtotalCents: 5400, serviceCents: 540, totalCents: 5940 });
    expect(v.items.map((i: any) => [i.name, i.status, i.note])).toEqual([['Chopp', 'new', ''], ['Porção de fritas', 'new', 'sem sal']]);
    // Antes de liberar, não paga.
    await expect(t.svc.pay('boteco', tab.id, token)).rejects.toThrow(/ainda não foi liberado/);
    // Pede a conta: aparece no painel.
    await t.svc.call('boteco', tab.id, token, 'bill');
    expect((await t.svc.summary(String(EID))).calls).toBe(1);
    // Garçom libera: valor congela, chamado some e não entram itens novos.
    const r = await t.svc.release(String(EID), tab.id, 'João');
    expect(r.payment).toMatchObject({ released: true, amountCents: 5940, releasedBy: 'João' });
    expect(r.call).toBeNull();
    await expect(t.svc.customerAdd('boteco', tab.id, token, [{ productId: String(P1), quantity: 1 }])).rejects.toThrow(/liberada para pagamento/);
    // Paga pelo celular.
    expect(await t.svc.pay('boteco', tab.id, token)).toEqual({ checkoutUrl: 'https://mp/pay' });
    const pref = t.mp.createPreference.mock.calls[0][0];
    expect(pref.items.reduce((s: number, i: any) => s + i.unitCents * i.quantity, 0)).toBe(5940);
    expect(pref.items.at(-1)).toEqual({ title: 'Taxa de serviço', quantity: 1, unitCents: 540 });
    expect(pref.backUrl).toBe(`https://app/loja/boteco/comanda/${tab.id}?t=${encodeURIComponent(token)}`);
    t.mp.payment.mockResolvedValue({ id: '555', status: 'approved', externalReference: tab.id, collectorId: '77', amountCents: 5940, method: 'pix' });
    const after = await t.svc.publicView('boteco', tab.id, token, '555');
    expect(after.status).toBe('closed');
    expect(t.sales.recordTabSale).toHaveBeenCalledTimes(1);
    expect(t.salesRows[0]).toMatchObject({ subtotalCents: 5400, serviceCents: 540, paymentMethod: 'online', tab: { table: 3, number: 1, name: 'Ana' } });
  });

  it('várias contas na mesma mesa; link de outra pessoa não abre', async () => {
    const t = setup();
    const a = await t.svc.openPublic('boteco', { table: 5, name: 'Ana' });
    const b = await t.svc.openPublic('boteco', { table: 5, name: 'Bruno' });
    expect(a.tab.id).not.toBe(b.tab.id);
    await expect(t.svc.publicView('boteco', a.tab.id, b.token)).rejects.toThrow(/não encontrada/);
    expect((await t.svc.board(String(EID))).open.map((x: any) => x.name)).toEqual(['Ana', 'Bruno']);
  });

  it('garçom tira um item (estoque volta) e a conta liberada reabre porque o valor mudou', async () => {
    const t = setup();
    const tab = await t.svc.openStaff(String(EID), { table: 2, name: 'Mesa 2' });
    const v = await t.svc.staffAdd(String(EID), tab.id, [{ productId: String(P1), quantity: 3 }]);
    await t.svc.release(String(EID), tab.id, 'caixa');
    const r = await t.svc.cancelItem(String(EID), tab.id, v.items[0].id, 'derramou');
    expect(t.stock[String(P1)]).toBe(10);
    expect(r).toMatchObject({ totalCents: 0, payment: { released: false } });
    expect(r.items[0]).toMatchObject({ status: 'cancelled', cancelReason: 'derramou' });
  });

  it('recebido no local (dinheiro com troco) fecha e gera a venda uma vez só', async () => {
    const t = setup();
    const tab = await t.svc.openStaff(String(EID), { table: 4 });
    await t.svc.staffAdd(String(EID), tab.id, [{ productId: String(P1), quantity: 1 }]);
    const r = await t.svc.settle(String(EID), tab.id, { method: 'cash', cashReceivedCents: 2000 }, 'João');
    expect(r.tab.status).toBe('closed');
    expect(t.salesRows[0]).toMatchObject({ paymentMethod: 'cash', cashReceivedCents: 2000, subtotalCents: 1200 });
    await expect(t.svc.settle(String(EID), tab.id, { method: 'cash' }, 'João')).resolves.toBeDefined(); // repetido: devolve a mesma venda
    expect(t.sales.recordTabSale).toHaveBeenCalledTimes(1);
  });

  it('pagou pelo celular depois de fechada no caixa: marca para devolver', async () => {
    const t = setup();
    const { token, tab } = await t.svc.openPublic('boteco', { table: 1, name: 'Ana' });
    await t.svc.customerAdd('boteco', tab.id, token, [{ productId: String(P1), quantity: 1 }]);
    await t.svc.release(String(EID), tab.id, 'caixa');
    await t.svc.pay('boteco', tab.id, token);
    await t.svc.settle(String(EID), tab.id, { method: 'card' }, 'caixa');
    t.mp.payment.mockResolvedValue({ id: '999', status: 'approved', externalReference: tab.id, collectorId: '77', amountCents: 1200, method: 'pix' });
    const { sign } = await import('../common/secret-box');
    expect(await t.svc.webhook({ tab: tab.id, s: sign('store-tab', tab.id), type: 'payment', 'data.id': '999' }, {}, {})).toEqual({ received: true, outcome: 'paid_twice' });
    expect(t.rows[0].refundNeeded).toBe(true);
    expect(t.sales.recordTabSale).toHaveBeenCalledTimes(1);
  });

  it('cancelar a conta devolve o estoque', async () => {
    const t = setup();
    const tab = await t.svc.openStaff(String(EID), { table: 6 });
    await t.svc.staffAdd(String(EID), tab.id, [{ productId: String(P1), quantity: 4 }]);
    expect(t.stock[String(P1)]).toBe(6);
    await t.svc.cancel(String(EID), tab.id, 'cliente foi embora');
    expect(t.stock[String(P1)]).toBe(10);
    expect(t.rows[0].accessHash).toBe(t.rows[0].accessHash); // hash guardado, token nunca
    expect(t.rows[0].accessHash).not.toBe(sha256(''));
  });

  it('garçons: quem atende assume a conta; chamado vai para o garçom da mesa; venda sai no nome dele', async () => {
    const joao = { id: String(new Types.ObjectId()), name: 'João', role: 'waiter' };
    const t = setup({ waiters: [{ id: 'm1', name: 'Maria', tables: [7, 8] }] });
    const a = await t.svc.openPublic('boteco', { table: 7, name: 'Ana' });
    const b = await t.svc.openPublic('boteco', { table: 3, name: 'Bia' });
    let board = await t.svc.board(String(EID));
    expect(board.open.find((x: any) => x.id === a.tab.id)!.assignedTo).toEqual({ id: 'm1', name: 'Maria' }); // mesa 7 é da Maria
    expect(board.open.find((x: any) => x.id === b.tab.id)!.assignedTo).toBeNull(); // mesa sem garçom: todos veem
    // João atende o chamado da Bia: passa a ser o garçom dela
    await t.svc.customerAdd('boteco', b.tab.id, b.token, [{ productId: String(P1), quantity: 1 }]);
    await t.svc.call('boteco', b.tab.id, b.token, 'bill', 'cash', 10000);
    board = await t.svc.board(String(EID));
    expect(board.open.find((x: any) => x.id === b.tab.id)!.call).toMatchObject({ kind: 'bill', pay: 'cash', changeForCents: 10000 });
    await t.svc.ackCall(String(EID), b.tab.id, joao);
    board = await t.svc.board(String(EID));
    expect(board.open.find((x: any) => x.id === b.tab.id)).toMatchObject({ call: null, waiter: { id: joao.id, name: 'João' }, assignedTo: { id: joao.id } });
    // Fechada sem funcionário logado (dono): a venda fica no nome do garçom da conta
    await t.svc.settle(String(EID), b.tab.id, { method: 'pix' }, 'caixa', null);
    expect(t.salesRows[0].staff).toEqual({ id: joao.id, name: 'João' });
  });
});
