import { Types } from 'mongoose';
import { sanitizeOptions } from '../products/options.rules';
import { baseShippingOptions, canCancel, canMove, carrierOption, inCepRanges, itemDims, modeOf, slugify, slugProblem, trackingUrlFor } from './store.rules';
import { parseQuotes } from './melhor-envio.client';
import { open, seal } from '../common/secret-box';
import { OrderService } from './order.service';
import { StoreService } from './store.service';
import { parseRange, sniffVideo } from './media.service';
import { StoreUpdateDto } from './dto/store.dto';
import { onlineEffectivePrice } from '../products/schema/product.schema';
import { BillingService, onlineFeeCents } from '../billing/billing.service';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { sign } from '../common/secret-box';

describe('loja online: regras', () => {
  it('endereço da loja', () => {
    expect(slugify('Bella Moda & Cia.')).toBe('bella-moda-cia');
    expect(slugify('Perfumaria São João')).toBe('perfumaria-sao-joao');
    expect(slugProblem('ab')).toMatch(/3 a 40/);
    expect(slugProblem('admin')).toMatch(/reservado/);
    expect(slugProblem('-loja')).not.toBeNull();
    expect(slugProblem('bella-moda')).toBeNull();
  });

  it('faixas de CEP (em qualquer ordem)', () => {
    const r = [{ from: '60000-000', to: '61999-999' }];
    expect(inCepRanges('60165121', r)).toBe(true);
    expect(inCepRanges('62000000', r)).toBe(false);
    expect(inCepRanges('60500000', [{ from: '61999999', to: '60000000' }])).toBe(true);
  });

  it('retirada, entrega local só dentro da faixa, frete fixo com grátis acima de X', () => {
    const cfg = {
      pickup: { enabled: true, instructions: 'Seg a sáb, 9h às 18h' },
      local: { enabled: true, priceCents: 800, cepRanges: [{ from: '60000000', to: '61999999' }], etaText: 'Mesmo dia' },
      fixed: { enabled: true, priceCents: 2500, freeAboveCents: 30000, minDays: 3, maxDays: 8 },
    };
    const inside = baseShippingOptions(cfg, '60165121', 10000);
    expect(inside.map((o) => [o.id, o.priceCents])).toEqual([['pickup', 0], ['local', 800], ['fixed', 2500]]);
    expect(inside[2].etaText).toBe('3 a 8 dias úteis');
    const outside = baseShippingOptions(cfg, '01310100', 30000);
    expect(outside.map((o) => o.id)).toEqual(['pickup', 'fixed']);
    expect(outside[1]).toMatchObject({ priceCents: 0, free: true });
    expect(baseShippingOptions(cfg, null, 100).map((o) => o.id)).toEqual(['pickup']); // sem CEP só retirada
  });

  it('transportadora: prazo de postagem, acréscimo e frete grátis', () => {
    const q = { id: 1, name: 'PAC', company: 'Correios', priceCents: 2190, minDays: 4, maxDays: 6 };
    expect(carrierOption(q, { handlingDays: 2, extraFeeCents: 300 }, 5000)).toMatchObject({ id: 'me:1', name: 'Correios PAC', priceCents: 2490, etaText: '6 a 8 dias úteis' });
    expect(carrierOption(q, { freeAboveCents: 5000 }, 5000).priceCents).toBe(0);
  });

  it('medidas: do produto, senão da embalagem padrão', () => {
    expect(itemDims({ weightGrams: 900 }, { weightGrams: 300, heightCm: 10, widthCm: 30, lengthCm: 40 })).toEqual({ weightGrams: 900, heightCm: 10, widthCm: 30, lengthCm: 40 });
  });

  it('Melhor Envio: ignora serviços com erro e ordena por preço', () => {
    const q = parseQuotes([
      { id: 2, name: 'SEDEX', price: '38.50', delivery_range: { min: 1, max: 2 }, company: { name: 'Correios' } },
      { id: 3, name: '.Com', error: 'Transportadora não atende' },
      { id: 1, name: 'PAC', custom_price: '21.90', custom_delivery_range: { min: 5, max: 7 }, company: { name: 'Correios' } },
    ]);
    expect(q).toEqual([
      { id: 1, name: 'PAC', company: 'Correios', priceCents: 2190, minDays: 5, maxDays: 7 },
      { id: 2, name: 'SEDEX', company: 'Correios', priceCents: 3850, minDays: 1, maxDays: 2 },
    ]);
  });

  it('status do pedido', () => {
    expect(canMove('paid', 'shipped', 'carrier')).toBe(true);
    expect(canMove('paid', 'shipped', 'pickup')).toBe(false);
    expect(canMove('paid', 'ready_for_pickup', 'carrier')).toBe(false);
    expect(canMove('pending_payment', 'preparing', 'fixed')).toBe(false);
    expect(canMove('delivered', 'shipped', 'fixed')).toBe(false);
    expect(canCancel('delivered')).toBe(false);
    expect(canCancel('shipped')).toBe(true);
    expect(trackingUrlFor('qb123456789br')).toContain('QB123456789BR');
    expect(trackingUrlFor('123')).toBeNull();
  });

  it('token do Melhor Envio cifrado (e adulteração é rejeitada)', () => {
    const s = seal('meu-token-secreto');
    expect(s).not.toContain('meu-token');
    expect(open(s)).toBe('meu-token-secreto');
    const parts = s.split(':'); parts[3] = Buffer.from('outra coisa').toString('base64');
    expect(open(parts.join(':'))).toBeNull();
  });
});

// ------------------------------------------------------------------ serviço de pedidos (mocks)

const eid = new Types.ObjectId();
const storeId = new Types.ObjectId();
const prodA = { _id: new Types.ObjectId(), name: 'Vestido Midi', code: 'V1', price: 189.9, priceWithDiscount: 0, trackStock: true, quantity: 5 };
const prodB = { _id: new Types.ObjectId(), name: 'Perfume 100ml', code: 'P1', price: 149.9, priceWithDiscount: 0, trackStock: true, quantity: 2 };

function setup(over: { linkFails?: boolean; refundFails?: boolean; promo?: { priceCents: number; grant: number }; trial?: boolean } = {}) {
  const docs = new Map<string, any>();
  const store: any = { _id: storeId, enterpriseId: eid, slug: 'bella-moda', name: 'Bella Moda', mp: { userId: '555' }, minOrderCents: 0, ordersPaused: false, theme: {}, shipping: {} };
  const asDoc = (d: any) => Object.assign(d, { toJSON: () => ({ ...d }) });
  const orders: any = {
    create: jest.fn(async ([d]) => { const doc = asDoc({ ...d, saleId: null, stockReleased: false, stockIssue: false, refundNeeded: false, tracking: { code: '', url: '' } }); docs.set(String(d._id), doc); return [doc]; }),
    updateOne: jest.fn(async (q, u) => { const d = docs.get(String(q._id)); if (d) for (const [k, v] of Object.entries(u.$set ?? {})) { if (k.includes('.')) { const [a, b] = k.split('.'); d[a] = { ...d[a], [b]: v }; } else d[k] = v; } return { modifiedCount: d ? 1 : 0 }; }),
    findOneAndUpdate: jest.fn(async (q, u, o) => {
      const d = docs.get(String(q._id)); if (!d) return null;
      const st = q.status;
      if (typeof st === 'string' && d.status !== st) return null;
      if (st?.$in && !st.$in.includes(d.status)) return null;
      if ('saleId' in q && d.saleId !== q.saleId) return null;
      if ('stockReleased' in q && d.stockReleased !== q.stockReleased) return null;
      if ('printedAt' in q && (d.printedAt ?? null) !== q.printedAt) return null;
      const before = { ...d };
      for (const [k, v] of Object.entries(u.$set ?? {})) { if (k.includes('.')) { const [a, b] = k.split('.'); d[a] = { ...d[a], [b]: v }; } else d[k] = v; }
      if (u.$push?.history) d.history = [...(d.history ?? []), u.$push.history];
      return o?.returnDocument === 'before' ? asDoc(before) : d;
    }),
    findById: jest.fn(async (id) => docs.get(String(id)) ?? null),
    findOne: jest.fn((q) => { const d = docs.get(String(q._id)); const r = d && (!q.enterpriseId || String(d.enterpriseId) === String(q.enterpriseId)) ? d : null; return Object.assign(Promise.resolve(r), { select: () => Promise.resolve(r) }); }),
  };
  const connection: any = { startSession: async () => ({ withTransaction: (fn: () => Promise<void>) => fn(), endSession: async () => undefined }) };
  const stock = new Map([[String(prodA._id), prodA.quantity], [String(prodB._id), prodB.quantity]]);
  const products: any = {
    publicMany: jest.fn(async (_e, ids: string[]) => [prodA, prodB].filter((p) => ids.includes(String(p._id)))),
    decreaseQuantity: jest.fn(async (_e, id, q) => { const s = stock.get(id)!; if (s < q) throw Object.assign(new Error('Estoque insuficiente'), { status: 409 }); stock.set(id, s - q); return { tracked: true }; }),
    increaseQuantity: jest.fn(async (_e, id, q) => { stock.set(id, stock.get(id)! + q); }),
  };
  const promoDoc = over.promo ? { _id: new Types.ObjectId(), promoPriceCents: over.promo.priceCents } : null;
  const promotions: any = {
    activeFor: jest.fn(async () => new Map(promoDoc ? [[String(prodA._id), promoDoc]] : [])),
    consume: jest.fn(async () => over.promo?.grant ?? 0), release: jest.fn(),
  };
  const stores: any = {
    publicBySlug: jest.fn(async () => ({ store, enterprise: {}, closed: false })),
    quote: jest.fn(async (_s, cep) => [{ id: 'pickup', kind: 'pickup', name: 'Retirar na loja', priceCents: 0, etaText: '' }, ...(cep ? [{ id: 'fixed', kind: 'fixed', name: 'Envio padrão', priceCents: 2500, etaText: '3 a 8 dias úteis' }] : [])]),
    nextOrderNumber: jest.fn(async () => 1001), getOrCreate: jest.fn(async () => store), mpAccessToken: jest.fn(async () => 'APP_USR-seller'),
  };
  const sales: any = { recordOnlineSale: jest.fn(async (_e, p) => ({ _id: new Types.ObjectId(), feeCents: p.collectedFeeCents })), recordCodSale: jest.fn(async () => ({ _id: new Types.ObjectId(), feeCents: 150 })), cancel: jest.fn(async () => ({})) };
  const payments = new Map<string, any>();
  const mp: any = {
    createPreference: jest.fn(async () => { if (over.linkFails) throw new Error('Mercado Pago fora'); return { id: 'pref-1', initPoint: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1' }; }),
    payment: jest.fn(async (id: string) => payments.get(id)),
    refund: jest.fn(async () => { if (over.refundFails) throw new Error('recusado'); }),
    verifySignature: jest.fn(() => true),
  };
  const mail: any = { send: jest.fn(async () => undefined) };
  const config: any = { get: (k: string) => ({ APP_URL: 'https://api.balcao.app', FRONTEND_URL: 'https://balcao.app' } as Record<string, string>)[k] };
  const enterprises: any = { findEnterpriseById: jest.fn(async () => ({ email: 'dono@bella.com', createdAt: new Date('2020-01-01'), trialEndsAt: over.trial ? new Date(Date.now() + 86_400_000) : new Date('2020-02-01') })) };
  const billing: any = { onlineRate: jest.fn(async (src: string) => (src === 'directory' ? 300 : 150)), reverseCollectedFee: jest.fn(async () => undefined) };
  const customers: any = { ensureForShopper: jest.fn(async () => ({ _id: new Types.ObjectId() })) };
  const shoppers: any = { rememberCheckout: jest.fn(async () => undefined) };
  // Sem cupom nem cashback nestes testes (o fluxo deles tem testes próprios em rewards.spec.ts).
  const rewards: any = { releaseCoupon: async () => undefined, restoreCredit: async () => undefined, reverseEarn: async () => undefined, earn: async () => undefined, respendIfNeeded: async () => undefined, cashbackOf: async () => null, balance: async () => 0 };
  const svc = new OrderService(orders, connection, stores, products, promotions, sales, mp, mail, config, enterprises, billing, customers, shoppers, rewards);
  /** Simula um pagamento no Mercado Pago para o pedido. */
  const pay = (orderId: string, o: Partial<{ status: string; amountCents: number; feeCents: number; collector: string; ref: string }> = {}) => {
    const id = String(900000 + payments.size);
    payments.set(id, { id, status: o.status ?? 'approved', statusDetail: '', externalReference: o.ref ?? orderId, amountCents: o.amountCents ?? docs.get(orderId).totalCents, collectorId: o.collector ?? '555', marketplaceFeeCents: o.feeCents ?? docs.get(orderId).feeCents, method: 'pix', approvedAt: null });
    return id;
  };
  return { svc, customers, shoppers, docs, orders, stock, products, promotions, stores, sales, mp, mail, store, billing, pay, payments };
}

const customer = { name: 'Ana Souza', email: 'ana@ex.com', phone: '85999990000' };
const ET = (() => { const exp = Date.now() + 3600_000; return `${exp}.${sign('checkout-email', `ana@ex.com.${exp}`)}`; })();
const address = { cep: '60165121', street: 'Rua A', number: '10', district: 'Meireles', city: 'Fortaleza', state: 'ce' };

const hook = (oid: string, payId: string, s?: string) => ({ q: { o: oid, s: s ?? sign('store-order', oid), type: 'payment', 'data.id': payId }, body: { type: 'payment', data: { id: payId } } });

describe('pedido online (Mercado Pago com comissão automática)', () => {
  it('checkout: reserva estoque, recalcula o frete e cria o pagamento na conta do lojista com a comissão', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 2 }, { productId: String(prodB._id), quantity: 1 }], customer, address, shippingOptionId: 'fixed' });
    expect(r).toMatchObject({ number: 1001, totalCents: 37980 + 14990 + 2500, checkoutUrl: expect.stringContaining('mercadopago.com.br') });
    expect(t.stock.get(String(prodA._id))).toBe(3);
    const pref = t.mp.createPreference.mock.calls[0][0];
    expect(pref.accessToken).toBe('APP_USR-seller');
    expect(pref.marketplaceFeeCents).toBe(Math.round((37980 + 14990) * 0.015)); // 1,5% dos produtos; frete fora
    expect(pref.items).toEqual([
      { title: 'Vestido Midi', quantity: 2, unitCents: 18990 },
      { title: 'Perfume 100ml', quantity: 1, unitCents: 14990 },
      { title: 'Frete - Envio padrão', quantity: 1, unitCents: 2500 },
    ]);
    expect(pref.notificationUrl).toBe(`https://api.balcao.app/public/store-webhook/mercadopago?o=${r.orderId}&s=${sign('store-order', r.orderId)}`);
    expect(pref.backUrl).toBe(`https://balcao.app/loja/bella-moda/pedido/${r.orderId}?t=${r.token}`);
    const doc = t.docs.get(r.orderId);
    expect(doc).toMatchObject({ payeeId: '555', address: { state: 'CE' } });
    expect(doc.accessHash).not.toBe(r.token);
  });

  it('loja sem Mercado Pago conectado não vende', async () => {
    const t = setup(); t.store.mp = { userId: '' };
    await expect(t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' })).rejects.toMatchObject({ status: 409 });
  });

  it('checkout: opção de frete que não existe para o CEP é recusada', async () => {
    const t = setup();
    await expect(t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'fixed' })).rejects.toMatchObject({ status: 422 });
    expect(t.products.decreaseQuantity).not.toHaveBeenCalled();
  });

  it('checkout: promoção com limite divide a linha (2 no promo + 1 no normal)', async () => {
    const t = setup({ promo: { priceCents: 15000, grant: 2 } });
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 3 }], customer, shippingOptionId: 'pickup' });
    expect(r.totalCents).toBe(2 * 15000 + 18990);
    expect(t.docs.get(r.orderId).address).toBeNull();
  });

  it('checkout com adicionais (cardápio): preço da escolha somado no servidor, uma linha por escolha, texto no pedido', async () => {
    const t = setup({ promo: { priceCents: 15000, grant: 1 } });
    (prodA as any).options = sanitizeOptions([
      { id: 'qj', name: 'Queijos', min: 2, max: 2, items: [{ id: 'mu', name: 'Mussarela' }, { id: 'go', name: 'Gorgonzola', priceCents: 400 }, { id: 'pr', name: 'Provolone' }] },
      { id: 'bd', name: 'Borda', max: 1, items: [{ id: 'ca', name: 'Catupiry', priceCents: 800 }] },
    ]);
    try {
      const pick = (...ids: string[]) => ids.map((i) => ({ g: i === 'ca' ? 'bd' : 'qj', i, q: 1 }));
      const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, customer, shippingOptionId: 'pickup', items: [
        { productId: String(prodA._id), quantity: 1, options: pick('mu', 'go', 'ca'), note: 'bem assada' },
        { productId: String(prodA._id), quantity: 2, options: pick('mu', 'pr') },
        { productId: String(prodA._id), quantity: 1, options: pick('pr', 'mu') }, // mesma escolha em outra ordem: junta
      ] });
      const items = t.docs.get(r.orderId).items;
      // O mock libera 1 unidade de promoção por linha. 1ª escolha: promoção + 1200 de adicionais;
      // 2ª (3 unidades, adicionais sem custo): 1 na promoção e 2 no preço normal.
      expect(items.map((i: any) => [i.quantity, i.unitPriceCents])).toEqual([[1, 15000 + 1200], [1, 15000], [2, 18990]]);
      expect(r.totalCents).toBe(16200 + 15000 + 2 * 18990);
      expect(items[0].options).toEqual([{ group: 'Queijos', name: 'Mussarela', qty: 1, priceCents: 0 }, { group: 'Queijos', name: 'Gorgonzola', qty: 1, priceCents: 400 }, { group: 'Borda', name: 'Catupiry', qty: 1, priceCents: 800 }]);
      expect(items[0].note).toBe('bem assada');
      expect(t.mp.createPreference.mock.calls[0][0].items[0].title).toBe('Vestido Midi (Queijos: Mussarela, Gorgonzola · Borda: Catupiry · Obs.: bem assada)');
      // Escolha que não fecha as regras do produto: 422 sem mexer no estoque.
      t.products.decreaseQuantity.mockClear();
      await expect(t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, customer, shippingOptionId: 'pickup', items: [{ productId: String(prodA._id), quantity: 1, options: pick('mu') }] })).rejects.toMatchObject({ status: 422 });
      expect(t.products.decreaseQuantity).not.toHaveBeenCalled();
    } finally { delete (prodA as any).options; }
  });

  it('impressão automática: só o primeiro computador reserva o pedido; pedido não pago não imprime', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    expect(await t.svc.claimPrint(String(eid), r.orderId)).toEqual({ claimed: false }); // ainda aguardando pagamento
    t.docs.get(r.orderId).status = 'paid';
    expect(await t.svc.claimPrint(String(eid), r.orderId)).toEqual({ claimed: true });
    expect(await t.svc.claimPrint(String(eid), r.orderId)).toEqual({ claimed: false }); // o outro computador pula
    expect(t.docs.get(r.orderId).printedAt).toBeInstanceOf(Date);
  });

  it('checkout: sem estoque não cria pedido', async () => {
    const t = setup();
    await expect(t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodB._id), quantity: 3 }], customer, shippingOptionId: 'pickup' })).rejects.toMatchObject({ status: 409 });
    expect(t.orders.create).not.toHaveBeenCalled();
  });

  it('checkout: Mercado Pago falhou → estoque devolvido e pedido cancelado', async () => {
    const t = setup({ linkFails: true });
    await expect(t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 2 }], customer, shippingOptionId: 'pickup' })).rejects.toThrow('Mercado Pago fora');
    expect(t.stock.get(String(prodA._id))).toBe(5);
    expect([...t.docs.values()][0].status).toBe('cancelled');
  });

  it('webhook: token errado é recusado; certo consulta o pagamento e vira venda com a comissão já recebida', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    const pid = t.pay(r.orderId);
    await expect(t.svc.webhook(hook(r.orderId, pid, 'errado').q, {}, {})).rejects.toMatchObject({ status: 401 });
    const h = hook(r.orderId, pid);
    expect((await t.svc.webhook(h.q, h.body, {})).outcome).toBe('applied');
    expect(t.mp.payment).toHaveBeenCalledWith(pid, 'APP_USR-seller');
    expect(t.sales.recordOnlineSale).toHaveBeenCalledWith(String(eid), expect.objectContaining({ totalCents: 18990, rateBps: 150, collectedFeeCents: 285 }), expect.anything());
    expect(t.docs.get(r.orderId)).toMatchObject({ status: 'paid', feeCents: 285, feeCharged: true, payment: expect.objectContaining({ paymentId: pid, method: 'pix' }) });
    expect((await t.svc.webhook(h.q, h.body, {})).outcome).toBe('already_paid');
    expect(t.sales.recordOnlineSale).toHaveBeenCalledTimes(1);
  });

  it('pagamento de outro pedido, de outra conta ou com valor menor não baixa', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    for (const [o, out] of [[{ ref: 'outro' }, 'not_this_order'], [{ collector: '999' }, 'wrong_account'], [{ amountCents: 100 }, 'amount_mismatch'], [{ status: 'pending' }, 'pending']] as const) {
      const h = hook(r.orderId, t.pay(r.orderId, o));
      expect((await t.svc.webhook(h.q, h.body, {})).outcome).toBe(out);
    }
    expect(t.docs.get(r.orderId).status).toBe('pending_payment');
  });

  it('volta do checkout confirma pelo payment_id; acompanhamento exige o token', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    await expect(t.svc.publicView('bella-moda', r.orderId, 'x'.repeat(32))).rejects.toMatchObject({ status: 404 });
    const c = await t.svc.confirmFromRedirect('bella-moda', r.orderId, { t: r.token, paymentId: t.pay(r.orderId) });
    expect(c.outcome).toBe('applied');
    expect(c.order).toMatchObject({ status: 'paid', customer: { name: 'Ana Souza' } });
    expect(c.order).not.toHaveProperty('fee');
    expect(c.order).not.toHaveProperty('customer.email');
  });

  it('expira sem pagamento: devolve estoque; pago depois, reserva de novo (ou avisa se faltou)', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodB._id), quantity: 2 }], customer, shippingOptionId: 'pickup' });
    expect(t.stock.get(String(prodB._id))).toBe(0);
    t.orders.find = () => ({ select: () => ({ limit: () => ({ lean: async () => [{ _id: new Types.ObjectId(r.orderId) }] }) }) });
    expect(await t.svc.expireStale(new Date(Date.now() + 2 * 3600_000))).toBe(1);
    expect(t.stock.get(String(prodB._id))).toBe(2);
    t.stock.set(String(prodB._id), 1);
    await t.svc.markPaid(new Types.ObjectId(r.orderId), { paymentId: '1', paidAmountCents: 29980, feeCents: 450 });
    expect(t.docs.get(r.orderId)).toMatchObject({ status: 'paid', stockIssue: true });
  });

  it('lojista: status, envio e cancelamento de pedido pago devolve o dinheiro pelo Mercado Pago', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, address, shippingOptionId: 'fixed' });
    await t.svc.confirmFromRedirect('bella-moda', r.orderId, { t: r.token, paymentId: t.pay(r.orderId) });
    await expect(t.svc.setStatus(String(eid), r.orderId, { status: 'ready_for_pickup' })).rejects.toMatchObject({ status: 409 });
    const shipped = await t.svc.setStatus(String(eid), r.orderId, { status: 'shipped', trackingCode: 'qb123456789br' });
    expect(shipped).toMatchObject({ status: 'shipped', tracking: { code: 'QB123456789BR' } });
    const c = await t.svc.cancel(String(eid), r.orderId, { reason: 'Cliente desistiu' });
    expect(t.mp.refund).toHaveBeenCalledWith(t.docs.get(r.orderId).payment.paymentId, 'APP_USR-seller', `refund-${r.orderId}`);
    expect(c).toMatchObject({ status: 'cancelled', refundNeeded: false, fee: { cents: 0 } });
    expect(t.sales.cancel).toHaveBeenCalledWith(String(eid), expect.any(String), expect.objectContaining({ fromOrder: true }));
    expect(t.billing.reverseCollectedFee).toHaveBeenCalled();
  });

  it('estorno automático falhou: cancela e avisa para devolver na mão', async () => {
    const t = setup({ refundFails: true });
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    await t.svc.confirmFromRedirect('bella-moda', r.orderId, { t: r.token, paymentId: t.pay(r.orderId) });
    expect(await t.svc.cancel(String(eid), r.orderId, { reason: 'Sem estoque' })).toMatchObject({ status: 'cancelled', refundNeeded: true });
  });

  it('devolvido direto no Mercado Pago (ou chargeback): o webhook cancela o pedido e desfaz a venda', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    const pid = t.pay(r.orderId);
    await t.svc.confirmFromRedirect('bella-moda', r.orderId, { t: r.token, paymentId: pid });
    t.payments.get(pid).status = 'refunded';
    const h = hook(r.orderId, pid);
    expect((await t.svc.webhook(h.q, h.body, {})).outcome).toBe('refunded');
    expect(t.docs.get(r.orderId)).toMatchObject({ status: 'cancelled', feeCents: 0, refundNeeded: false });
    expect(t.sales.cancel).toHaveBeenCalled();
  });
});

describe('pagar na entrega (cardápio e loja virtual)', () => {
  const cod = (t: ReturnType<typeof setup>, method: 'cash' | 'card' | 'pix' = 'cash') => t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup', payOnDelivery: { method, changeForCents: 10000 } } as any);
  it('só quando a loja aceita, e nunca no e-commerce', async () => {
    const t = setup();
    await expect(cod(t)).rejects.toThrow(/não aceita/);
    Object.assign(t.store, { mode: 'ecommerce', payOnDelivery: { enabled: true, methods: ['cash'] } });
    await expect(cod(t)).rejects.toThrow(/não aceita/);
    Object.assign(t.store, { mode: 'menu' });
    await expect(cod(t, 'card')).rejects.toThrow(/não aceita/);
  });
  it('confirma sem Mercado Pago, reserva o estoque, e vira venda quando a loja registra o recebimento', async () => {
    const t = setup();
    Object.assign(t.store, { mode: 'menu', payOnDelivery: { enabled: true, methods: ['cash', 'card', 'pix'] } });
    const r = await cod(t);
    expect(r.checkoutUrl).toBeNull();
    expect(t.mp.createPreference).not.toHaveBeenCalled();
    const o = t.docs.get(r.orderId);
    expect(o).toMatchObject({ status: 'confirmed', payment: { mode: 'on_delivery', onDelivery: { method: 'cash', changeForCents: 10000 } } });
    expect(t.stock.get(String(prodA._id))).toBe(prodA.quantity - 1);
    await expect(t.svc.setStatus(String(eid), r.orderId, { status: 'delivered' } as any)).rejects.toThrow(/Entregue e pago/);
    const done = await t.svc.collect(String(eid), r.orderId, { method: 'cash', cashReceivedCents: 10000 });
    expect(done.status).toBe('delivered');
    expect(t.sales.recordCodSale).toHaveBeenCalledWith(String(eid), expect.objectContaining({ paymentMethod: 'cash', cashReceivedCents: 10000, rateBps: 150 }), expect.anything());
    await expect(t.svc.collect(String(eid), r.orderId, { method: 'cash' })).rejects.toThrow(/já registrado/);
  });
  it('cancelar antes de receber só devolve o estoque (sem estorno)', async () => {
    const t = setup();
    Object.assign(t.store, { mode: 'catalog', payOnDelivery: { enabled: true, methods: ['pix'] } });
    const r = await cod(t, 'pix');
    await t.svc.cancel(String(eid), r.orderId, { reason: 'cliente desistiu' });
    expect(t.docs.get(r.orderId).status).toBe('cancelled');
    expect(t.stock.get(String(prodA._id))).toBe(prodA.quantity);
    expect(t.mp.refund).not.toHaveBeenCalled();
  });
});

describe('comprador logado', () => {
  it('checkout logado: vira cliente da loja, pedido e venda ficam ligados ao cadastro e à conta', async () => {
    const t = setup();
    const shopper: any = { _id: new Types.ObjectId(), name: 'Ana Souza', email: 'ana@ex.com', phone: '', addresses: [] };
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, address, shippingOptionId: 'fixed' }, shopper);
    expect(t.customers.ensureForShopper).toHaveBeenCalledWith(String(eid), expect.objectContaining({ _id: shopper._id, email: 'ana@ex.com', phone: '85999990000' }), expect.stringContaining('Rua A, 10'), expect.anything());
    const doc = t.docs.get(r.orderId);
    expect(String(doc.shopperId)).toBe(String(shopper._id));
    expect(doc.customerId).toBeTruthy();
    expect(t.shoppers.rememberCheckout).toHaveBeenCalled();
    const pid = t.pay(r.orderId);
    const h = hook(r.orderId, pid);
    await t.svc.webhook(h.q, h.body, {});
    expect(t.sales.recordOnlineSale).toHaveBeenCalledWith(String(eid), expect.objectContaining({ customerId: doc.customerId }), expect.anything());
  });

  it('visitante continua comprando sem conta (sem cadastro automático)', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    expect(t.customers.ensureForShopper).not.toHaveBeenCalled();
    expect(t.docs.get(r.orderId).shopperId).toBeNull();
  });
});

describe('taxa da loja online', () => {
  it('cliente vindo da página "Lojas no Balcão" paga 3%; link da loja 1,5%; frete fica de fora', async () => {
    const t = setup();
    const a = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, address, shippingOptionId: 'fixed', source: 'directory' });
    expect(t.docs.get(a.orderId)).toMatchObject({ source: 'directory', feeRateBps: 300, feeCents: 570, feeCharged: false });
    expect(t.mp.createPreference.mock.calls[0][0].marketplaceFeeCents).toBe(570);
    const b = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    expect(t.docs.get(b.orderId)).toMatchObject({ source: 'store', feeRateBps: 150, feeCents: 285 });
    expect((t.svc.present(t.docs.get(a.orderId)) as any).fee).toEqual({ source: 'directory', rateBps: 300, cents: 570, charged: false });
  });
  it('no teste grátis a comissão é zero', async () => {
    const t = setup({ trial: true });
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
    expect(t.docs.get(r.orderId).feeCents).toBe(0);
    expect(t.mp.createPreference.mock.calls[0][0].marketplaceFeeCents).toBe(0);
  });
  it('comissão recebida fica registrada sem virar dívida nem fatura', async () => {
    expect(onlineFeeCents(18990, 150)).toBe(285);
    const created: any[] = [];
    const fee: any = { create: jest.fn(async (d) => { created.push(...d); return d; }) };
    const ent: any = { addDebt: jest.fn() };
    const svc = new BillingService(fee, {} as any, {} as any, {} as any, ent, {} as any, { get: () => undefined } as any, {} as any);
    await expect(svc.recordCollectedFee(String(eid), new Types.ObjectId(), 100000, 150, 1500, {} as any)).resolves.toBe(1500);
    expect(created[0]).toMatchObject({ channel: 'online', collected: true, feeCents: 1500 });
    expect(ent.addDebt).not.toHaveBeenCalled();
  });
});

describe('Mercado Pago: assinatura do webhook e conexão', () => {
  it('confere x-signature quando MP_WEBHOOK_SECRET existe', () => {
    const { createHmac } = require('crypto');
    const mp = new MercadoPagoClient({ get: (k: string) => (k === 'MP_WEBHOOK_SECRET' ? 'segredo' : undefined) } as any);
    const v1 = createHmac('sha256', 'segredo').update('id:123;request-id:req-1;ts:1700000000;').digest('hex');
    expect(mp.verifySignature('123', 'req-1', `ts=1700000000,v1=${v1}`)).toBe(true);
    expect(mp.verifySignature('123', 'req-1', `ts=1700000000,v1=${'0'.repeat(64)}`)).toBe(false);
  });
  it('state do OAuth é amarrado à empresa e expira', async () => {
    const doc: any = { _id: storeId, enterpriseId: eid, slug: 'bella', name: 'Bella', mp: {}, shipping: {}, toJSON() { return { ...this }; } };
    const stores: any = { findOne: jest.fn(() => Object.assign(Promise.resolve(doc), { select: () => ({ lean: async () => ({ shipping: {} }) }) })), updateOne: jest.fn(async (_q, u) => Object.assign(doc, u.$set)), findById: () => ({ select: () => ({ lean: async () => ({ shipping: {} }) }) }) };
    const mp: any = { authUrl: (st: string) => `https://auth.mercadopago.com.br/authorization?state=${st}`, exchangeCode: jest.fn(async () => ({ accessToken: 'AT', refreshToken: 'RT', userId: '555', publicKey: 'PK', expiresAt: new Date(Date.now() + 1e10) })), me: async () => ({ id: '555', nickname: 'BELLAMODA', email: 'b@b.com' }) };
    const settings: any = { policy: async () => ({ onlineRateBps: 150, directoryRateBps: 300 }) };
    const svc = new StoreService(stores, { findEnterpriseById: async () => ({}) } as any, {} as any, {} as any, {} as any, settings, mp, {} as any);
    const { url } = await svc.mpConnectUrl(String(eid));
    const state = new URL(url).searchParams.get('state')!;
    await expect(svc.mpCallback(new Types.ObjectId().toHexString(), 'code', state)).rejects.toMatchObject({ status: 422 });
    const v = await svc.mpCallback(String(eid), 'code', state);
    expect(doc.mp).toMatchObject({ userId: '555', nickname: 'BELLAMODA' });
    expect(doc.mp.accessSealed).not.toContain('AT');
    expect(v.mp).not.toHaveProperty('accessSealed');
  });
});

describe('configuração da loja', () => {
  it('ligar a loja exige aceitar a taxa da loja online', async () => {
    const doc: any = { _id: storeId, enterpriseId: eid, slug: 'bella', name: 'Bella', mp: { userId: '555' }, feeAcceptedAt: null, shipping: { pickup: { enabled: true } }, toJSON() { return { ...this }; } };
    const stores: any = {
      findOne: jest.fn(() => Object.assign(Promise.resolve(doc), { select: () => ({ lean: async () => ({ shipping: {} }) }) })), updateOne: jest.fn(async (_q, u) => Object.assign(doc, Object.fromEntries(Object.entries(u.$set).filter(([k]) => !k.includes('.'))))),
      findById: () => ({ select: () => ({ lean: async () => ({ shipping: {} }) }) }),
    };
    const settings: any = { policy: async () => ({ onlineRateBps: 150, directoryRateBps: 300 }) };
    const ents: any = { findEnterpriseById: async () => ({ createdAt: new Date('2020-01-01'), trialEndsAt: new Date('2020-02-01') }) };
    const svc = new StoreService(stores, ents, {} as any, {} as any, {} as any, settings, {} as any, {} as any);
    await expect(svc.update(String(eid), { enabled: true })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FEE_ACCEPT_REQUIRED' }) });
    const v = await svc.update(String(eid), { enabled: true, acceptOnlineFee: true });
    expect(v).toMatchObject({ enabled: true, fees: { onlineRateBps: 150, directoryRateBps: 300, waived: null } });
    expect(doc.feeAcceptedAt).toBeInstanceOf(Date);
    expect(doc.feeAcceptedRates).toEqual({ onlineRateBps: 150, directoryRateBps: 300 });
  });

  it('salvar só a aparência (aba Tema) não desliga a loja, mesmo com o checklist incompleto', async () => {
    const doc: any = { _id: storeId, enterpriseId: eid, slug: 'bella', name: 'Bella', enabled: true, mp: { userId: '' }, shipping: { pickup: { enabled: true } }, feeAcceptedAt: new Date(), theme: { accent: '#111111' }, toJSON() { return { ...this }; } };
    const stores: any = {
      findOne: jest.fn(() => Object.assign(Promise.resolve(doc), { select: () => ({ lean: async () => ({ shipping: {} }) }) })), updateOne: jest.fn(async (_q, u) => Object.assign(doc, Object.fromEntries(Object.entries(u.$set).filter(([k]) => !k.includes('.'))))),
      findById: () => ({ select: () => ({ lean: async () => ({ shipping: {} }) }) }),
    };
    const settings: any = { policy: async () => ({ onlineRateBps: 150, directoryRateBps: 300 }) };
    const storage: any = { resolve: async (_e: string, _k: string, v: string) => v, release: async () => undefined };
    const svc = new StoreService(stores, { findEnterpriseById: async () => ({}) } as any, {} as any, {} as any, {} as any, settings, {} as any, storage);
    await svc.update(String(eid), { theme: { accent: '#FF3D00', font: 'cinzel' } } as any);
    expect(doc.enabled).toBe(true);
    await expect(svc.update(String(eid), { minOrderCents: 500 } as any)).rejects.toMatchObject({ status: 422 });
    expect(doc.enabled).toBe(false);
  });

  it('não liga sem Mercado Pago conectado', async () => {
    const doc: any = { _id: storeId, enterpriseId: eid, slug: 'bella', name: 'Bella', mp: { userId: '' }, shipping: { pickup: { enabled: true } }, feeAcceptedAt: new Date(), toJSON() { return { ...this }; } };
    const stores: any = {
      findOne: jest.fn(() => Object.assign(Promise.resolve(doc), { select: () => ({ lean: async () => ({ shipping: {} }) }) })), updateOne: jest.fn(async (_q, u) => Object.assign(doc, Object.fromEntries(Object.entries(u.$set).filter(([k]) => !k.includes('.'))))),
      findById: () => ({ select: () => ({ lean: async () => ({ shipping: {} }) }) }),
    };
    const settings: any = { policy: async () => ({ onlineRateBps: 150, directoryRateBps: 300 }) };
    const svc = new StoreService(stores, { findEnterpriseById: async () => ({}) } as any, {} as any, {} as any, {} as any, settings, {} as any, {} as any);
    await expect(svc.update(String(eid), { enabled: true })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Mercado Pago') });
    expect(doc.enabled).toBe(false);
  });

});

describe('preço da loja online e banners', () => {
  it('produto com preço online: vitrine e checkout cobram o preço online', async () => {
    const t = setup();
    (prodA as any).onlinePrice = 179.9;
    try {
      const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' });
      expect(r.totalCents).toBe(17990);
      expect(t.docs.get(r.orderId).items[0]).toMatchObject({ unitPriceCents: 17990, originalUnitPriceCents: 18990 });
    } finally { delete (prodA as any).onlinePrice; }
    expect(onlineEffectivePrice({ price: 100, priceWithDiscount: 90, onlinePrice: null })).toBe(90);
    expect(onlineEffectivePrice({ price: 100, priceWithDiscount: 90, onlinePrice: 120 })).toBe(120);
  });

  it('banners: até 6, imagem válida e link só interno ou https', async () => {
    const { plainToInstance } = require('class-transformer');
    const { validate } = require('class-validator');
    const img = 'data:image/webp;base64,AAAA';
    const ok = plainToInstance(StoreUpdateDto, { slides: [{ image: img, title: 'Coleção de verão', link: 'cat:' + 'a'.repeat(24) }, { image: img, link: 'https://instagram.com/bella' }, { image: img, link: '#ofertas' }] });
    expect(await validate(ok)).toHaveLength(0);
    for (const bad of [{ image: 'javascript:alert(1)' }, { image: img, link: 'javascript:alert(1)' }, { image: img, link: 'http://inseguro.com' }]) {
      expect((await validate(plainToInstance(StoreUpdateDto, { slides: [bad] }))).length).toBeGreaterThan(0);
    }
    expect((await validate(plainToInstance(StoreUpdateDto, { slides: Array(7).fill({ image: img }) }))).length).toBeGreaterThan(0);
  });
});

describe('prévia da loja desligada', () => {
  const mk = (enabled: boolean) => {
    const doc: any = { _id: storeId, enterpriseId: eid, slug: 'bella', name: 'Bella', enabled, ordersPaused: false, mp: { userId: '' }, shipping: {}, theme: {}, contacts: {}, policies: {}, toJSON() { return { ...this }; } };
    const stores: any = { findOne: jest.fn(async () => doc) };
    const ents: any = { findEnterpriseById: async () => ({ status: 'active', billing: { status: 'active' } }) };
    return new StoreService(stores, ents, {} as any, { list: async () => [] } as any, {} as any, { policy: async () => ({}) } as any, {} as any, {} as any);
  };
  it('sem token, loja desligada não existe; com o token do dono aparece, marcada como prévia e sem aceitar pedidos', async () => {
    const svc = mk(false);
    await expect(svc.publicBySlug('bella')).rejects.toMatchObject({ status: 404 });
    const { token } = await svc.previewLink(String(eid));
    await expect(svc.publicBySlug('bella', { preview: token })).resolves.toMatchObject({ preview: true, closed: true });
    await expect(svc.publicBySlug('bella', { preview: token, forOrder: true })).rejects.toMatchObject({ status: 409 });
    await expect(svc.publicBySlug('bella', { preview: token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) })).rejects.toMatchObject({ status: 404 });
    const [id, , sig] = token.split('.');
    await expect(svc.publicBySlug('bella', { preview: `${id}.${Date.now() - 1000}.${sig}` })).rejects.toMatchObject({ status: 404 });
  });
  it('loja suspensa pela plataforma: nem a prévia abre e o lojista não consegue religar', async () => {
    const doc: any = { _id: storeId, enterpriseId: eid, slug: 'bella', name: 'Bella', enabled: false, mp: { userId: '555' }, shipping: { pickup: { enabled: true } }, theme: {}, contacts: {}, policies: {}, feeAcceptedAt: new Date(), adminBlock: { at: new Date(), reason: 'Denúncia de produto falsificado', by: 'adm@x.com' }, toJSON() { return { ...this }; } };
    const stores: any = { findOne: jest.fn(async () => doc), updateOne: jest.fn() };
    const svc = new StoreService(stores, { findEnterpriseById: async () => ({ status: 'active' }) } as any, {} as any, {} as any, {} as any, { policy: async () => ({}) } as any, {} as any, {} as any);
    const { token } = await svc.previewLink(String(eid));
    await expect(svc.publicBySlug('bella', { preview: token })).rejects.toMatchObject({ status: 404 });
    await expect(svc.update(String(eid), { enabled: true })).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'STORE_BLOCKED', message: expect.stringContaining('produto falsificado') }) });
    expect(stores.updateOne).not.toHaveBeenCalled();
  });
  it('loja ligada ignora o token (não fica marcada como prévia)', async () => {
    const svc = mk(true);
    const { token } = await svc.previewLink(String(eid));
    await expect(svc.publicBySlug('bella', { preview: token })).resolves.toMatchObject({ preview: false, closed: false });
  });
});

describe('dados do vendedor e aceite da compra', () => {
  it('CPF/CNPJ com dígito verificador', () => {
    const { validDoc, formatDoc } = require('../common/br-doc');
    expect(validDoc('11.222.333/0001-81')).toBe(true);
    expect(validDoc('11.222.333/0001-82')).toBe(false);
    expect(validDoc('529.982.247-25')).toBe(true);
    expect(validDoc('111.111.111-11')).toBe(false);
    expect(formatDoc('11222333000181')).toBe('11.222.333/0001-81');
  });
  it('pedido guarda a prova do aceite (data, versão, IP)', async () => {
    const t = setup();
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, termsVersion: '2026-11-02', items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'pickup' } as any, null, '200.1.2.3');
    expect(t.docs.get(r.orderId).consent).toMatchObject({ termsVersion: '2026-11-02', ip: '200.1.2.3', acceptedAt: expect.any(Date) });
  });
});

describe('pedido na mesa (bares e restaurantes)', () => {
  const tableQuote = (t: ReturnType<typeof setup>) => t.stores.quote.mockImplementation(async () => [{ id: 'table', kind: 'table', name: 'Na mesa', priceCents: 0, etaText: 'Levamos até você', free: true }]);
  it('pedido vai para a mesa escolhida, sem endereço nem frete', async () => {
    const t = setup(); t.store.tables = { enabled: true, count: 12, label: 'Mesa' }; tableQuote(t);
    const r = await t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'table', table: 7 });
    const doc = t.docs.get(r.orderId);
    expect(doc).toMatchObject({ table: 7, address: null, shipping: { kind: 'table', name: 'Mesa 7', priceCents: 0 } });
    expect(r.totalCents).toBe(18990);
    expect(t.svc.present(doc)).toMatchObject({ table: 7 });
  });
  it('mesa fora do intervalo ou não informada é recusada antes de reservar estoque', async () => {
    const t = setup(); t.store.tables = { enabled: true, count: 12, label: 'Mesa' }; tableQuote(t);
    await expect(t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'table', table: 13 })).rejects.toMatchObject({ status: 422 });
    await expect(t.svc.checkout('bella-moda', { acceptTerms: true, emailToken: ET, items: [{ productId: String(prodA._id), quantity: 1 }], customer, shippingOptionId: 'table' })).rejects.toMatchObject({ status: 422 });
    expect(t.products.decreaseQuantity).not.toHaveBeenCalled();
  });
  it('pedido de mesa não pode ser marcado como "enviado"', () => {
    expect(canMove('paid', 'shipped', 'table')).toBe(false);
    expect(canMove('paid', 'preparing', 'table')).toBe(true);
    expect(canMove('preparing', 'delivered', 'table')).toBe(true);
    expect(canMove('paid', 'ready_for_pickup', 'table')).toBe(false);
  });
  it('a cotação oferece "na mesa" só quando a loja ativou', async () => {
    const svc = new StoreService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const base: any = { shipping: { pickup: { enabled: true } }, tables: { enabled: false } };
    expect((await svc.quote(base, null, [])).map((o) => o.id)).toEqual(['pickup']);
    base.tables = { enabled: true, count: 5, label: 'Comanda', payment: 'upfront' };
    expect((await svc.quote(base, null, [])).map((o) => o.kind)).toEqual(['table', 'pickup']);
    // Comanda (paga no fim): a mesa não passa pelo checkout.
    base.tables.payment = 'tab';
    expect((await svc.quote(base, null, [])).map((o) => o.kind)).toEqual(['pickup']);
  });

  it('o modo da loja limita as formas de entrega', async () => {
    const svc = new StoreService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const s: any = { mode: 'catalog', shipping: { pickup: { enabled: true }, fixed: { enabled: true, priceCents: 1000 }, local: { enabled: true, cepRanges: [{ from: '60000000', to: '60999999' }] } }, tables: { enabled: false } };
    expect((await svc.quote(s, '60165121', [])).map((o) => o.kind)).toEqual(['pickup', 'local']);
    s.mode = 'ecommerce';
    expect((await svc.quote(s, '60165121', [])).map((o) => o.kind)).toEqual(['pickup', 'local', 'fixed']);
    expect(modeOf({ tables: { enabled: true } })).toBe('menu');
    expect(modeOf({ theme: { layout: 'classic' } })).toBe('ecommerce');
  });
});

describe('vídeos da vitrine', () => {
  it('reconhece MP4, MOV e WEBM pela assinatura e recusa o resto', () => {
    const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex');
    const mov = Buffer.from('0000001466747970717420200000000071742020', 'hex');
    const webm = Buffer.from('1a45dfa3a34286810142f7810142f2810442f381', 'hex');
    expect(sniffVideo(mp4)).toBe('video/mp4');
    expect(sniffVideo(mov)).toBe('video/quicktime');
    expect(sniffVideo(webm)).toBe('video/webm');
    expect(sniffVideo(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffVideo(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))).toBeNull(); // PNG
  });
  it('entende os trechos pedidos pelo player', () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
    expect(parseRange('bytes=5-2', 1000)).toBe('invalid');
    expect(parseRange('items=0-1', 1000)).toBe('invalid');
  });
});
