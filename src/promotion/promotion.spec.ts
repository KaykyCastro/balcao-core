import { Types } from 'mongoose';
import { SaleService } from '../sale/sale.service';
import { percentPrice, promoUnits, promotionStatus, remainingUnits } from './promotion.rules';
import { PromotionService } from './promotion.service';

const now = new Date('2026-10-30T12:00:00Z');
const P = (o: Partial<{ startsAt: Date; endsAt: Date | null; endedAt: Date | null; limitUnits: number | null; soldUnits: number }> = {}) =>
  ({ startsAt: new Date('2026-10-01'), endsAt: null, endedAt: null, limitUnits: 10, soldUnits: 0, ...o });

describe('promoção: regras', () => {
  it('status', () => {
    expect(promotionStatus(P(), now)).toBe('active');
    expect(promotionStatus(P({ soldUnits: 10 }), now)).toBe('sold_out');
    expect(promotionStatus(P({ endsAt: new Date('2026-10-29') }), now)).toBe('expired');
    expect(promotionStatus(P({ startsAt: new Date('2026-11-01') }), now)).toBe('scheduled');
    expect(promotionStatus(P({ endedAt: now }), now)).toBe('ended');
    expect(promotionStatus(P({ limitUnits: null, soldUnits: 999 }), now)).toBe('active');
  });
  it('unidades no preço promocional respeitam o limite', () => {
    expect(promoUnits(P({ soldUnits: 7 }), 5)).toBe(3);
    expect(promoUnits(P({ soldUnits: 10 }), 5)).toBe(0);
    expect(promoUnits(P({ limitUnits: null }), 5)).toBe(5);
    expect(remainingUnits(P({ soldUnits: 4 }))).toBe(6);
  });
  it('preço por percentual', () => expect(percentPrice(2790, 20)).toBe(2232));
});

describe('promoção: serviço', () => {
  const product = { _id: new Types.ObjectId(), name: 'Arroz', code: 'A1', price: 27.9, priceWithDiscount: 0 };
  const mk = (open = false) => {
    const promos: any = { exists: jest.fn().mockResolvedValue(open), create: jest.fn(async (d) => ({ ...d, _id: new Types.ObjectId(), toObject() { return this; } })), updateOne: jest.fn(), findById: jest.fn() };
    const products: any = { findOne: jest.fn().mockResolvedValue(product) };
    return { svc: new PromotionService(promos, products), promos };
  };
  const eid = new Types.ObjectId().toHexString(); const pid = String(product._id);

  it('cria com percentual sobre o preço cheio e limite de unidades', async () => {
    const { svc } = mk();
    const v = await svc.create(eid, { productId: pid, mode: 'percent', percent: 10, limitUnits: 50 });
    expect(v).toMatchObject({ promoPriceCents: 2511, regularPriceCents: 2790, limitUnits: 50, soldUnits: 0, remaining: 50, status: 'active', name: 'Arroz' });
  });
  it('recusa preço que não é menor que o atual', async () => {
    await expect(mk().svc.create(eid, { productId: pid, mode: 'price', price: 27.9 })).rejects.toMatchObject({ status: 400 });
  });
  it('recusa segunda promoção aberta no mesmo produto', async () => {
    await expect(mk(true).svc.create(eid, { productId: pid, mode: 'price', price: 20 })).rejects.toMatchObject({ status: 409 });
  });
  it('consume: reserva só o que cabe no limite, com escrita condicional', async () => {
    const { svc, promos } = mk();
    promos.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const promo: any = { _id: new Types.ObjectId(), ...P({ soldUnits: 8 }) };
    await expect(svc.consume(promo, 5, {} as any)).resolves.toBe(2);
    expect(promos.updateOne.mock.calls[0][0]).toMatchObject({ soldUnits: 8, endedAt: null });
    expect(promos.updateOne.mock.calls[0][1]).toEqual({ $inc: { soldUnits: 2 } });
  });
  it('consume: outra venda pegou as últimas unidades no meio → relê e devolve 0', async () => {
    const { svc, promos } = mk();
    promos.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    promos.findById.mockReturnValue({ session: () => Promise.resolve({ _id: 'x', ...P({ soldUnits: 10 }) }) });
    await expect(svc.consume({ _id: 'x', ...P({ soldUnits: 9 }) } as any, 3, {} as any)).resolves.toBe(0);
  });
});

describe('venda com promoção', () => {
  const eid = new Types.ObjectId().toHexString();
  const prod = { _id: new Types.ObjectId(), name: 'Café', code: 'C1', price: 18.9, priceWithDiscount: 0, trackStock: true };
  const setup = (granted: number) => {
    const created: any[] = [];
    const saleModel: any = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn(async (docs) => { created.push(...docs); return docs; }) };
    const connection: any = { startSession: async () => ({ withTransaction: (fn: () => Promise<void>) => fn(), endSession: async () => undefined }) };
    const productService: any = { getProductById: jest.fn().mockResolvedValue(prod), decreaseQuantity: jest.fn().mockResolvedValue({ tracked: true }) };
    const customerService: any = {};
    const billing: any = { applyFee: jest.fn().mockResolvedValue(10) };
    const promo = { _id: new Types.ObjectId(), promoPriceCents: 1500 };
    const promotion: any = { activeFor: jest.fn().mockResolvedValue(new Map([[String(prod._id), promo]])), consume: jest.fn().mockResolvedValue(granted), release: jest.fn() };
    return { svc: new SaleService(saleModel, connection, productService, customerService, billing, promotion), created, promotion, promo, billing };
  };

  it('5 unidades, só 3 restam na promoção: 3 a R$ 15,00 + 2 a R$ 18,90', async () => {
    const { svc, created, promo, billing } = setup(3);
    await svc.create(eid, { paymentMethod: 'pix', items: [{ productId: String(prod._id), quantity: 5 }] } as any);
    const sale = created[0];
    expect(sale.items).toEqual([
      expect.objectContaining({ quantity: 3, unitPriceCents: 1500, totalCents: 4500, promotionId: promo._id, originalUnitPriceCents: 1890 }),
      expect.objectContaining({ quantity: 2, unitPriceCents: 1890, totalCents: 3780 }),
    ]);
    expect(sale.items[1].promotionId).toBeUndefined();
    expect(sale.totalCents).toBe(8280);
    expect(billing.applyFee.mock.calls[0][2]).toBe(8280);
  });
  it('promoção esgotada: tudo pelo preço normal', async () => {
    const { svc, created } = setup(0);
    await svc.create(eid, { paymentMethod: 'pix', items: [{ productId: String(prod._id), quantity: 2 }] } as any);
    expect(created[0].items).toEqual([expect.objectContaining({ quantity: 2, unitPriceCents: 1890 })]);
  });
  it('dinheiro: o troco usa o total já com a promoção', async () => {
    const { svc, created } = setup(1);
    await svc.create(eid, { paymentMethod: 'cash', cashReceivedCents: 2000, items: [{ productId: String(prod._id), quantity: 1 }] } as any);
    expect(created[0]).toMatchObject({ totalCents: 1500, cashReceivedCents: 2000, changeCents: 500 });
  });
  it('cancelar devolve as unidades para a promoção', async () => {
    const { svc, promotion, promo } = setup(0);
    const sale: any = { _id: 's', paymentMethod: 'pix', items: [{ productId: prod._id, quantity: 3, promotionId: promo._id, stockTracked: true }, { productId: prod._id, quantity: 2, stockTracked: true }], save: jest.fn() };
    (svc as any).saleModel.findOneAndUpdate = jest.fn().mockResolvedValue(sale);
    (svc as any).productService.increaseQuantity = jest.fn();
    (svc as any).billingService.reverseFee = jest.fn().mockResolvedValue(false);
    await svc.cancel(eid, 's');
    expect(promotion.release).toHaveBeenCalledTimes(1);
    expect(promotion.release.mock.calls[0].slice(0, 2)).toEqual([promo._id, 3]);
  });
});
