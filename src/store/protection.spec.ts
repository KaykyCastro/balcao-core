import { Types } from 'mongoose';
import { disputeBlock, PROTECTION, shipByOf } from './protection';
import { ProtectionService } from './protection.service';
import { EmailCodeService } from './email-code.service';
import { LogisticsService } from './logistics.service';
import { packageFor } from './store.rules';

const DAY = 86_400_000;
const base = (o: any = {}) => ({ status: 'paid', shipping: { kind: 'fixed' }, protection: { status: 'active', shipBy: new Date(Date.now() + DAY) }, dispute: null, payment: {}, history: [], ...o });

describe('Compra protegida: regras', () => {
  it('prazo de envio: 3 dias (retirada 2)', () => {
    const t = new Date('2026-11-02T12:00:00Z');
    expect(shipByOf('fixed', t).getTime() - t.getTime()).toBe(PROTECTION.shipDays * DAY);
    expect(shipByOf('pickup', t).getTime() - t.getTime()).toBe(PROTECTION.pickupDays * DAY);
  });
  it('prazos pelo modo da loja: cardápio em horas, loja virtual em 1 dia; comida não tem desistência', () => {
    const t = new Date('2026-11-02T12:00:00Z');
    expect(shipByOf('local', t, 'menu').getTime() - t.getTime()).toBe(2 * 3_600_000);
    expect(shipByOf('local', t, 'catalog').getTime() - t.getTime()).toBe(DAY);
    const food = base({ status: 'delivered', protection: { status: 'active', shipBy: t, mode: 'menu' }, history: [{ status: 'delivered', at: new Date() }] });
    expect(disputeBlock(food as any, 'regret')).toMatch(/comida/);
    expect(disputeBlock(food as any, 'different')).toBeNull();
  });
  it('"não recebi" antes do prazo explica até quando a loja pode enviar', () => {
    expect(disputeBlock(base() as any, 'not_received')).toMatch(/tem até .* para enviar/);
    expect(disputeBlock(base({ protection: { status: 'active', shipBy: new Date(Date.now() - DAY) } }) as any, 'not_received')).toBeNull();
  });
  it('desistência só até 7 dias depois de receber; defeito só depois de enviado', () => {
    const delivered = (daysAgo: number) => base({ status: 'delivered', history: [{ status: 'delivered', at: new Date(Date.now() - daysAgo * DAY) }] });
    expect(disputeBlock(delivered(3) as any, 'regret')).toBeNull();
    expect(disputeBlock(delivered(9) as any, 'regret')).toMatch(/já passou/);
    expect(disputeBlock(base() as any, 'damaged')).toMatch(/depois de receber/);
    expect(disputeBlock(delivered(1) as any, 'damaged')).toBeNull();
  });
  it('não abre duas, nem em pedido reembolsado, cancelado ou de mesa', () => {
    expect(disputeBlock(base({ status: 'delivered', dispute: { status: 'open' } }) as any, 'damaged')).toMatch(/aberta/);
    expect(disputeBlock(base({ status: 'delivered', payment: { refundedAt: new Date() } }) as any, 'damaged')).toMatch(/reembolsado/);
    expect(disputeBlock(base({ status: 'cancelled' }) as any, 'damaged')).toMatch(/não está pago/);
    expect(disputeBlock(base({ shipping: { kind: 'table' } }) as any, 'not_received')).toMatch(/mesa/);
  });
});

function setup(rows: any[]) {
  const docs = new Map(rows.map((r) => [String(r._id), r]));
  const orders: any = {
    find: jest.fn((q: any) => ({ limit: async () => rows.filter((r) => match(r, q)) })),
    findById: jest.fn((id: any) => Object.assign(Promise.resolve(docs.get(String(id))), { select: () => ({ lean: async () => ({ linkSealed: null }) }) })),
    updateOne: jest.fn(async (q: any, u: any) => { const d = docs.get(String(q._id)); if (d) apply(d, u); }),
    updateMany: jest.fn(async (q: any, u: any) => { const hit = rows.filter((r) => match(r, q)); hit.forEach((d) => apply(d, u)); return { modifiedCount: hit.length }; }),
    findOneAndUpdate: jest.fn(async (q: any, u: any) => { const d = docs.get(String(q._id)); if (!d) return null; apply(d, u); return d; }),
  };
  const get = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);
  function match(r: any, q: any): boolean {
    return Object.entries(q).every(([k, v]: [string, any]) => {
      if (k === '$or') return v.some((sub: any) => match(r, sub));
      const x = get(r, k);
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('$in' in v) return v.$in.includes(x);
        if ('$ne' in v) return x !== v.$ne;
        if ('$lte' in v) return x != null && new Date(x) <= v.$lte;
      }
      if (v === null) return x == null;
      return x === v;
    });
  }
  function apply(d: any, u: any) {
    for (const [k, v] of Object.entries(u.$set ?? {})) { const parts = k.split('.'); let o = d; for (const p of parts.slice(0, -1)) o = o[p] ??= {}; o[parts.at(-1)!] = v; }
    if (u.$push?.history) d.history = [...(d.history ?? []), u.$push.history];
  }
  const orderService: any = { cancel: jest.fn(async (_e: string, id: string) => { const d = docs.get(id); d.status = 'cancelled'; d.payment.refundedAt = new Date(); }), present: (o: any) => ({ id: String(o._id), number: o.number, status: o.status }) };
  const mail: any = { send: jest.fn(async () => undefined) };
  const enterprises: any = { findEnterpriseById: jest.fn(async () => ({ email: 'dono@loja.com' })) };
  const mp: any = { refund: jest.fn(async () => undefined) };
  const stores: any = { mpAccessToken: jest.fn(async () => 'APP_USR-x') };
  const billing: any = { reverseCollectedFee: jest.fn(async () => undefined) };
  const svc = new ProtectionService(orders, orderService, stores, mp, mail, enterprises, billing);
  return { svc, orderService, mail, mp, billing };
}
const order = (o: any) => ({ _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId(), storeId: new Types.ObjectId(), number: 1001, totalCents: 10000, customer: { name: 'Ana', email: 'ana@ex.com' }, shipping: { kind: 'fixed', name: 'PAC' }, payment: { paymentId: '123' }, history: [], saleId: new Types.ObjectId(), ...o });

describe('Compra protegida: rotina', () => {
  it('avisa 12 h antes, cancela e devolve depois do prazo + 2 dias, confirma entregue sem queixa e sobe reclamação parada', async () => {
    const now = new Date();
    const warn = order({ status: 'paid', protection: { status: 'active', shipBy: new Date(now.getTime() + 6 * 3600_000), warnedAt: null } });
    const late = order({ status: 'preparing', protection: { status: 'active', shipBy: new Date(now.getTime() - 3 * DAY), warnedAt: now } });
    const okDelivered = order({ status: 'delivered', protection: { status: 'active', autoConfirmAt: new Date(now.getTime() - 1000) } });
    const stuck = order({ status: 'delivered', protection: { status: 'disputed' }, dispute: { status: 'open', openedAt: new Date(now.getTime() - 4 * DAY), sellerRepliedAt: null, escalatedAt: null } });
    const table = order({ status: 'paid', shipping: { kind: 'table' }, protection: null });
    const t = setup([warn, late, okDelivered, stuck, table]);
    const r = await t.svc.tick(now);
    expect(r).toMatchObject({ warned: 1, cancelled: 1, confirmed: 1, escalated: 1 });
    expect(t.mail.send.mock.calls[0][0]).toBe('dono@loja.com');
    expect(t.orderService.cancel).toHaveBeenCalledWith(String(late.enterpriseId), String(late._id), { reason: 'Prazo de envio esgotado (Compra protegida)' });
    expect(late.protection.status).toBe('refunded');
    expect(okDelivered.protection.status).toBe('confirmed');
    expect(stuck.dispute.escalatedAt).toBeInstanceOf(Date);
  });

  it('reclamação → reembolso depois de entregue estorna no Mercado Pago e desfaz a taxa', async () => {
    const o = order({ status: 'delivered', protection: { status: 'active' }, history: [{ status: 'delivered', at: new Date() }] });
    const t = setup([o]);
    await t.svc.openDispute(o as any, 'damaged', 'Veio com a costura aberta');
    expect(o.dispute.status).toBe('open');
    expect(o.protection.status).toBe('disputed');
    await t.svc.resolve(String(o._id), 'refund', 'adm@balcao.app', 'Fotos comprovam o defeito');
    expect(t.mp.refund).toHaveBeenCalledWith('123', 'APP_USR-x', `refund-${o._id}`);
    expect(o).toMatchObject({ dispute: { status: 'resolved_refund' }, protection: { status: 'refunded' } });
    expect(t.billing.reverseCollectedFee).toHaveBeenCalled();
  });

  it('comprador confirma o recebimento: vira entregue e encerra a proteção', async () => {
    const o = order({ status: 'shipped', protection: { status: 'active' } });
    const t = setup([o]);
    await t.svc.received(o as any, 'cliente');
    expect(o.status).toBe('delivered');
    expect(o.protection.status).toBe('confirmed');
  });
});

describe('compra sem cadastro: e-mail confirmado por código', () => {
  it('envia código, confere e devolve um comprovante que só vale para aquele e-mail', async () => {
    const store: any[] = [];
    const col: any = {
      createIndex: jest.fn(async () => undefined),
      find: jest.fn((q: any) => { const rows = store.filter((r) => r.email === q.email && (q.used === undefined || r.used === q.used)).sort((a, b) => b.createdAt - a.createdAt); const c: any = { sort: () => c, limit: () => c, toArray: async () => rows, next: async () => rows[0] ?? null }; return c; }),
      insertOne: jest.fn(async (d: any) => { store.push({ _id: store.length, ...d }); }),
      updateOne: jest.fn(async (q: any, u: any) => { const d = store.find((r) => r._id === q._id); if (u.$set) Object.assign(d, u.$set); if (u.$inc) d.attempts += 1; }),
    };
    const mail: any = { send: jest.fn(async () => undefined) };
    const svc = new EmailCodeService({ collection: () => col } as any, mail);
    await svc.send('Ana@Ex.com', 'Loja');
    const code = /(\d{6})/.exec(mail.send.mock.calls[0][2])![1];
    await expect(svc.send('ana@ex.com', 'Loja')).rejects.toMatchObject({ status: 429 }); // pedir de novo logo em seguida
    await expect(svc.verify('ana@ex.com', code === '000000' ? '111111' : '000000')).rejects.toMatchObject({ status: 422 });
    const { emailToken } = await svc.verify('ana@ex.com', code);
    expect(EmailCodeService.valid('ANA@ex.com', emailToken)).toBe(true);
    expect(EmailCodeService.valid('outra@ex.com', emailToken)).toBe(false);
    expect(EmailCodeService.valid('ana@ex.com', `${Date.now() - 1}.${emailToken.split('.')[1]}`)).toBe(false);
    await expect(svc.verify('ana@ex.com', code)).rejects.toMatchObject({ status: 422 }); // código usado não vale de novo
  });
});

describe('logística', () => {
  it('caixa do pedido: soma peso, empilha altura e usa a maior base', () => {
    expect(packageFor([{ dims: { weightGrams: 400, heightCm: 5, widthCm: 30, lengthCm: 40 }, quantity: 2 }, { dims: {}, quantity: 1 }], { weightGrams: 300, heightCm: 4, widthCm: 20, lengthCm: 25 }))
      .toEqual({ weightGrams: 1100, heightCm: 14, widthCm: 30, lengthCm: 40 });
  });
  it('remetente incompleto lista o que falta', () => {
    expect(LogisticsService.senderMissing({ originCep: '', sender: { name: 'Loja', phone: '85999990000' } })).toEqual(['e-mail', 'CPF ou CNPJ', 'rua', 'número', 'bairro', 'cidade', 'UF', 'CEP de origem']);
  });
  it('rastreio: postado vira "Enviado" com código e aviso; entregue vira "Entregue"', async () => {
    const eid = new Types.ObjectId();
    const o: any = { _id: new Types.ObjectId(), enterpriseId: eid, status: 'preparing', label: { id: 'ME-1', status: 'generated' }, protection: { status: 'active' }, history: [] };
    const orders: any = {
      find: jest.fn(() => ({ limit: async () => [o] })),
      findOneAndUpdate: jest.fn(async (_q: any, u: any) => { Object.assign(o, { status: u.$set.status }); o.tracking = { code: u.$set['tracking.code'] }; return o; }),
      updateOne: jest.fn(async (_q: any, u: any) => { if (u.$set.status) o.status = u.$set.status; o.auto = u.$set['protection.autoConfirmAt']; }),
    };
    const stores: any = { findOne: () => ({ select: () => ({ lean: async () => ({ shipping: { melhorEnvio: { enabled: true, tokenSealed: null } } }) }) }) };
    const me: any = { tracking: jest.fn(async () => ({ 'ME-1': { status: 'delivered', tracking: 'AA123456789BR' } })) };
    const orderService: any = { notifyCustomer: jest.fn(async () => undefined) };
    const svc = new LogisticsService(orders, stores, me, orderService, {} as any);
    jest.spyOn(svc as any, 'storeMe').mockResolvedValue({ token: 't', sandbox: true });
    expect(await svc.syncTracking()).toEqual({ shipped: 1, delivered: 1 });
    expect(o.tracking.code).toBe('AA123456789BR');
    expect(o.status).toBe('delivered');
    expect(o.auto).toBeInstanceOf(Date);
    expect(orderService.notifyCustomer).toHaveBeenCalled();
  });
});
