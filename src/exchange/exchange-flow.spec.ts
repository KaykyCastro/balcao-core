import { Types } from 'mongoose';
import { ExchangeService } from './exchange.service';

const EID = new Types.ObjectId().toHexString();
const P1 = new Types.ObjectId(), P2 = new Types.ObjectId();
const CUST = new Types.ObjectId();

function setup(over: { daysAgo?: number; paymentMethod?: string; customer?: boolean; debit?: number } = {}) {
  const sale: any = {
    _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId(EID), status: 'completed', channel: 'pos', paymentMethod: over.paymentMethod ?? 'cash',
    customerId: over.customer === false ? null : CUST, createdAt: new Date(Date.now() - (over.daysAgo ?? 2) * 86_400_000),
    // Vestido 2 × 100,00 (200,00) + Bolsa 1 × 50,00; desconto de 25,00 no carrinho → pagou 225,00
    items: [{ productId: P1, productName: 'Vestido', productCode: 'V1', quantity: 2, unitPriceCents: 10000, totalCents: 20000, stockTracked: true }, { productId: P2, productName: 'Bolsa', productCode: 'B1', quantity: 1, unitPriceCents: 5000, totalCents: 5000, stockTracked: true }],
    discountCents: 2500, totalCents: 22500,
  };
  const rows: any[] = [];
  const q = (v: any) => Object.assign(Promise.resolve(v), { session: () => Object.assign(Promise.resolve(v), { lean: async () => v }), lean: async () => v, sort() { return this; }, skip() { return this; }, limit() { return this; } });
  const exchanges: any = {
    find: jest.fn(() => q(rows.slice())),
    findOne: jest.fn((f: any) => q(rows.find((r) => r.idempotencyKey === f.idempotencyKey) ?? null)),
    create: jest.fn(async ([d]: any[]) => { const doc = { ...d, createdAt: new Date() }; rows.push(doc); return [doc]; }),
    countDocuments: jest.fn(async () => rows.length),
  };
  const saleModel: any = { findOne: jest.fn(() => q(sale)), updateOne: jest.fn(async () => ({})), aggregate: jest.fn(async () => [{ _id: sale._id }]) };
  const connection: any = { startSession: async () => ({ withTransaction: (fn: () => Promise<void>) => fn(), endSession: async () => undefined }) };
  const stock = new Map<string, number>([[String(P1), 5], [String(P2), 5]]);
  const products: any = { increaseQuantity: jest.fn(async (_e: string, id: string, n: number) => { stock.set(id, stock.get(id)! + n); }) };
  const newSales: any[] = [];
  const sales: any = {
    quote: jest.fn(async (_e: string, items: any[]) => ({ totalCents: items.reduce((a, i) => a + i.quantity * 8000, 0) })),
    prepare: jest.fn(async () => ({})),
    write: jest.fn(async (_e: string, dto: any, _p: any, _s: any, opts: any) => {
      const total = dto.items.reduce((a: number, i: any) => a + i.quantity * 8000, 0);
      const s = { _id: opts.saleId, totalCents: total, paymentMethod: total - Math.min(total, opts.exchange.cents) > 0 ? dto.paymentMethod : 'exchange', exchangeCents: Math.min(total, opts.exchange.cents) };
      newSales.push(s); return s;
    }),
  };
  let debit = over.debit ?? 0; let credit = 0;
  const customers: any = {
    getCustomerById: jest.fn(async () => ({ _id: CUST, name: 'Ana', debitCents: debit, creditCents: credit })),
    reduceDebitUpTo: jest.fn(async (_e: string, _id: string, c: number) => { debit = Math.max(0, debit - c); }),
    addCredit: jest.fn(async (_e: string, _id: string, c: number) => { credit += c; }),
  };
  const svc = new ExchangeService(exchanges, saleModel, connection, sales, products, customers);
  return { svc, sale, rows, stock, newSales, customers, saleModel, get credit() { return credit; }, get debit() { return debit; } };
}

describe('trocas: fluxo', () => {
  it('devolução sem produto novo: estoque volta e a sobra vira crédito do cliente (valor pago, com desconto)', async () => {
    const t = setup();
    const r = await t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 0, quantity: 1 }], leftover: 'credit' }, null);
    expect(r).toMatchObject({ returnedCents: 9000, creditCents: 9000, refundCents: 0, newSaleId: null }); // 20.000 − 2.000 de desconto, metade
    expect(t.stock.get(String(P1))).toBe(6);
    expect(t.credit).toBe(9000);
    expect(t.saleModel.updateOne).toHaveBeenCalledWith(expect.anything(), { $inc: { returnedCents: 9000 } }, expect.anything()); // trava da venda
  });

  it('troca por produto mais caro: o valor devolvido paga parte e o cliente paga a diferença', async () => {
    const t = setup();
    const r = await t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 1, quantity: 1 }], items: [{ productId: String(P1), quantity: 1 }], payMethod: 'pix' }, null);
    // Bolsa pagou 4.500 (5.000 − 500 de desconto); produto novo 8.000 → diferença 3.500 no Pix
    expect(r).toMatchObject({ returnedCents: 4500, newCents: 8000, toPayCents: 3500, payMethod: 'pix', creditCents: 0 });
    expect(t.newSales[0]).toMatchObject({ exchangeCents: 4500, paymentMethod: 'pix' });
  });

  it('sobra sem cliente cadastrado: crédito é recusado; dinheiro de volta funciona', async () => {
    const t = setup({ customer: false });
    await expect(t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 0, quantity: 2 }], leftover: 'credit' }, null)).rejects.toMatchObject({ response: { code: 'EXCHANGE_CUSTOMER_REQUIRED' } });
    const t2 = setup({ customer: false });
    const r = await t2.svc.create(EID, { saleId: String(t2.sale._id), returns: [{ line: 0, quantity: 2 }], leftover: 'refund', refundMethod: 'cash' }, null);
    expect(r).toMatchObject({ returnedCents: 18000, refundCents: 18000, refundMethod: 'cash' });
  });

  it('venda no fiado: a sobra abate primeiro a dívida em aberto', async () => {
    const t = setup({ paymentMethod: 'fiado', debit: 5000 });
    const r = await t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 0, quantity: 1 }], leftover: 'credit' }, null);
    expect(r).toMatchObject({ returnedCents: 9000, debtAbatedCents: 5000, creditCents: 4000 });
    expect(t.debit).toBe(0);
  });

  it('fora dos 7 dias, ou devolvendo mais do que foi vendido: recusado', async () => {
    const t = setup({ daysAgo: 8 });
    await expect(t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 0, quantity: 1 }], leftover: 'credit' }, null)).rejects.toMatchObject({ response: { code: 'EXCHANGE_NOT_ALLOWED' } });
    const t2 = setup();
    await t2.svc.create(EID, { saleId: String(t2.sale._id), returns: [{ line: 0, quantity: 2 }], leftover: 'credit' }, null);
    await expect(t2.svc.create(EID, { saleId: String(t2.sale._id), returns: [{ line: 0, quantity: 1 }], leftover: 'credit' }, null)).rejects.toMatchObject({ response: { code: 'EXCHANGE_QTY_TOO_HIGH' } });
  });

  it('a mesma troca enviada duas vezes (mesma chave) acontece uma vez só', async () => {
    const t = setup();
    const a = await t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 0, quantity: 1 }], leftover: 'credit' }, null, 'troca-abc12345');
    const b = await t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 0, quantity: 1 }], leftover: 'credit' }, null, 'troca-abc12345');
    expect(b.id).toBe(a.id);
    expect(t.rows).toHaveLength(1);
    expect(t.stock.get(String(P1))).toBe(6);
  });

  it('busca pelo comprovante: mostra o valor pago por item e quanto ainda pode voltar', async () => {
    const t = setup();
    await t.svc.create(EID, { saleId: String(t.sale._id), returns: [{ line: 0, quantity: 1 }], leftover: 'credit' }, null);
    const v = await t.svc.lookup(EID, 'Nº ' + String(t.sale._id).slice(-6).toUpperCase());
    expect(v.eligible).toBe(true);
    expect(v.lines[0]).toMatchObject({ paidCents: 18000, paidUnitCents: 9000, returnedQty: 1, returnableQty: 1 });
    expect(v.lines[1]).toMatchObject({ paidCents: 4500, returnableQty: 1 });
    expect(v.exchanges).toHaveLength(1);
  });
});
