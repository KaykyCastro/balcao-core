import { Types } from 'mongoose';
import { AutopayService, autopayRef } from './autopay.service';
import { BillingNoticeService } from './billing-notice.service';
import { nextChargeDate } from './autopay.rules';

/** Model em memória, só o que os serviços usam. */
function fakeModel(rows: any[]) {
  const get = (d: any, k: string) => k.split('.').reduce((o, p) => (o == null ? o : o[p]), d);
  const match = (d: any, f: any): boolean => Object.entries(f ?? {}).every(([k, v]: any) => {
    const x = get(d, k);
    if (v && typeof v === 'object' && !(v instanceof Types.ObjectId) && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.map(String).includes(String(x));
      if ('$gt' in v) return x > v.$gt;
      if ('$ne' in v) return Array.isArray(get(d, k.split('.')[0])) ? !get(d, k.split('.')[0]).some((r: any) => r[k.split('.')[1]] === v.$ne) : String(x) !== String(v.$ne);
    }
    if (k === 'reminders.kind') return (d.reminders ?? []).some((r: any) => r.kind === v);
    return String(x ?? null) === String(v);
  });
  const q = (val: any) => { const p: any = Promise.resolve(val); p.select = () => p; p.lean = () => p; p.sort = () => p; p.limit = () => p; return p; };
  const set = (d: any, path: string, val: any) => { const ks = path.split('.'); let o = d; ks.slice(0, -1).forEach((k) => (o = o[k] ??= {})); o[ks.at(-1)!] = val; };
  return {
    rows,
    find: jest.fn((f) => q(rows.filter((d) => match(d, f)).sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0)))),
    findById: jest.fn((id) => q(rows.find((d) => String(d._id) === String(id)))),
    findOne: jest.fn((f) => q(rows.find((d) => match(d, f)))),
    exists: jest.fn(async (f) => rows.some((d) => match(d, f))),
    distinct: jest.fn(async (_k, f) => rows.filter((d) => match(d, f)).map((d) => d._id)),
    create: jest.fn(async (d) => { rows.push(d); return d; }),
    updateOne: jest.fn(async (f, u) => {
      const d = rows.find((x) => match(x, f)); if (!d) return { modifiedCount: 0 };
      for (const [k, v] of Object.entries(u.$set ?? {})) {
        if (k.includes('.$.')) { const [arr, field] = k.split('.$.'); const r = d[arr].find((x: any) => x.kind === f['reminders.kind']); if (r) r[field] = v; } else set(d, k, v);
      }
      for (const [k, v] of Object.entries(u.$push ?? {})) (d[k] ??= []).push(v);
      return { modifiedCount: 1 };
    }),
  };
}

const eid = String(new Types.ObjectId());
function setup() {
  const ent: any = { _id: new Types.ObjectId(eid), name: 'Pele Boa', email: 'loja@ex.com', role: 'user', autopay: null, feeCapCents: null, billingNotify: null };
  const enterprises = fakeModel([ent]);
  const day = 86_400_000; const now = Date.now();
  const invA: any = { _id: new Types.ObjectId(), enterpriseId: ent._id, status: 'pending', amountCents: 4000, dueDate: new Date(now + 10 * day), reminders: [] };
  const invB: any = { _id: new Types.ObjectId(), enterpriseId: ent._id, status: 'pending', amountCents: 1990, dueDate: new Date(now + 12 * day), reminders: [] };
  const invoices = fakeModel([invA, invB]);
  const events = fakeModel([]);
  const pp = { id: 'pre_1', status: 'pending', initPoint: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre_1', externalReference: autopayRef(eid), amountCents: 4000, nextPaymentDate: new Date(now + 5 * day) };
  const payments: Record<string, any> = {};
  const mp: any = {
    platformToken: 'x',
    createPreapproval: jest.fn(async (p) => ({ ...pp, amountCents: p.amountCents })),
    getPreapproval: jest.fn(async () => ({ ...pp, status: 'authorized' })),
    updatePreapproval: jest.fn(async (_id, p) => ({ ...pp, status: p.status ?? 'authorized', amountCents: p.amountCents ?? pp.amountCents })),
    authorizedPayments: jest.fn(async () => Object.keys(payments).map((k) => ({ id: 'ap_' + k, paymentId: k, status: payments[k].status, amountCents: payments[k].amountCents }))),
    authorizedPayment: jest.fn(async (id) => ({ id, preapprovalId: 'pre_1', paymentId: id.replace('ap_', '') })),
    payment: jest.fn(async (id) => ({ id, ...payments[id], method: 'credit_card' })),
    verifySignature: () => true,
  };
  const billing: any = { markPaid: jest.fn(async (id, info) => { const i = invoices.rows.find((x: any) => String(x._id) === String(id) && x.status === 'pending'); if (!i) return false; i.status = 'paid'; i.paymentId = info.paymentId; return true; }) };
  const settings: any = { policy: async () => ({ capCents: 4000 }) };
  const config: any = { get: (k: string) => (k === 'FRONTEND_URL' ? 'https://balcao.app' : k === 'MP_ACCESS_TOKEN' ? 'APP_USR-teste' : undefined) };
  const svc = new AutopayService(enterprises as any, invoices as any, events as any, mp, billing, settings, config);
  return { svc, ent, invA, invB, mp, payments, billing, invoices, enterprises, config };
}

describe('cobrança automática no cartão (assinatura do Mercado Pago)', () => {
  it('cobra sempre no dia 3, depois de a fatura sair e antes de vencer', () => {
    expect(nextChargeDate(new Date('2026-11-06T12:00:00Z')).toISOString()).toBe('2026-12-03T15:00:00.000Z');
    expect(nextChargeDate(new Date('2026-11-02T12:00:00Z')).toISOString()).toBe('2026-11-03T15:00:00.000Z');
    expect(nextChargeDate(new Date('2026-12-20T12:00:00Z')).toISOString()).toBe('2027-01-03T15:00:00.000Z');
  });

  it('o lojista cadastra o cartão no Mercado Pago: aqui só o id e o estado da assinatura', async () => {
    const t = setup();
    expect(await t.svc.start(eid)).toEqual({ url: expect.stringMatching(/^https:\/\/www\.mercadopago/) });
    expect(t.mp.createPreapproval).toHaveBeenCalledWith(expect.objectContaining({ externalReference: autopayRef(eid), payerEmail: 'loja@ex.com', backUrl: 'https://balcao.app/app/pagamento?cartao=1' }));
    expect(Object.keys(t.ent.autopay).sort()).toEqual(['amountCents', 'nextChargeAt', 'preapprovalId', 'status', 'updatedAt']);
    expect(JSON.stringify(t.ent)).not.toMatch(/card|cartao|cvv|last_four/i);
    await t.svc.sync(eid);
    expect(t.ent.autopay.status).toBe('authorized');
    await expect(t.svc.start(eid)).rejects.toMatchObject({ response: { code: 'AUTOPAY_ACTIVE' } });
  });

  it('sem a conta do Balcão no Mercado Pago, avisa em vez de quebrar', async () => {
    const t = setup();
    const off = new AutopayService(t.enterprises as any, t.invoices as any, {} as any, t.mp, t.billing, { policy: async () => ({ capCents: 4000 }) } as any, { get: () => undefined } as any);
    await expect(off.start(eid)).rejects.toMatchObject({ response: { code: 'AUTOPAY_UNAVAILABLE' } });
    expect(t.mp.createPreapproval).not.toHaveBeenCalled();
  });

  it('fatura nova: o próximo ciclo cobra o que está em aberto; sem fatura, pausa', async () => {
    const t = setup();
    t.ent.autopay = { preapprovalId: 'pre_1', status: 'authorized', amountCents: 4000 };
    await t.svc.prepareAll();
    expect(t.mp.updatePreapproval).toHaveBeenCalledWith('pre_1', { amountCents: 5990, status: 'authorized' });
    t.invA.status = 'paid'; t.invB.status = 'paid';
    await t.svc.prepareAll();
    expect(t.mp.updatePreapproval).toHaveBeenLastCalledWith('pre_1', { status: 'paused' });
  });

  it('pagamento aprovado quita as faturas da mais antiga para a mais nova, uma vez só', async () => {
    const t = setup();
    t.ent.autopay = { preapprovalId: 'pre_1', status: 'authorized', amountCents: 5990 };
    t.payments['111'] = { status: 'rejected', amountCents: 5990 };
    expect(await t.svc.reconcile(eid)).toBe(0);
    t.payments['222'] = { status: 'approved', amountCents: 5990 };
    expect(await t.svc.reconcile(eid)).toBe(2);
    expect([t.invA.status, t.invB.status]).toEqual(['paid', 'paid']);
    expect(await t.svc.reconcile(eid)).toBe(0);
    expect(t.billing.markPaid).toHaveBeenCalledTimes(2);
  });

  it('webhook só aplica pagamento de assinatura desta plataforma (tudo reconsultado)', async () => {
    const t = setup();
    t.ent.autopay = { preapprovalId: 'pre_1', status: 'authorized', amountCents: 4000 };
    t.payments['333'] = { status: 'approved', amountCents: 4000 };
    expect(await t.svc.webhook({}, { type: 'subscription_authorized_payment', data: { id: 'ap_333' } }, {})).toEqual({ received: true, outcome: 'applied' });
    expect(t.invA.status).toBe('paid');
    t.mp.authorizedPayment.mockResolvedValueOnce({ id: 'ap_9', preapprovalId: 'de_outro', paymentId: '9' });
    expect((await t.svc.webhook({}, { type: 'subscription_authorized_payment', data: { id: 'ap_9' } }, {})).outcome).toBe('unknown');
  });
});

describe('avisos da fatura (e-mail, painel, WhatsApp)', () => {
  function notices(t: ReturnType<typeof setup>, waOn = false) {
    const mail = { send: jest.fn(async () => undefined) };
    const messages = { notify: jest.fn(async () => undefined) };
    const wa = { configured: true, sendInvoiceTemplate: jest.fn(async () => true) };
    if (waOn) t.ent.billingNotify = { whatsapp: '5581998765432', whatsappOptInAt: new Date() };
    return { svc: new BillingNoticeService(t.invoices as any, t.enterprises as any, mail as any, messages as any, wa as any, t.config), mail, messages, wa };
  }

  it('manda uma vez por fatura e registra os canais', async () => {
    const t = setup(); const n = notices(t);
    expect(await n.svc.run()).toBe(2);
    expect(n.mail.send).toHaveBeenCalledWith('loja@ex.com', expect.stringContaining('Sua fatura do Balcão'), expect.stringContaining('https://balcao.app/app/pagamento?fatura='));
    expect(n.wa.sendInvoiceTemplate).not.toHaveBeenCalled(); // sem o "sim" do lojista
    expect(t.invA.reminders).toEqual([expect.objectContaining({ kind: 'issued', channels: ['email', 'painel'] })]);
    expect(await n.svc.run()).toBe(0);
  });

  it('WhatsApp só com o aceite; vence amanhã é aviso de alerta', async () => {
    const t = setup(); const n = notices(t, true);
    t.invA.dueDate = new Date(Date.now() + 0.5 * 86_400_000);
    await n.svc.run();
    expect(n.wa.sendInvoiceTemplate).toHaveBeenCalledWith('5581998765432', ['Pele', expect.stringContaining('vence amanhã'), 'R$ 40,00', expect.stringContaining('/app/pagamento?fatura=')]);
    expect(n.messages.notify).toHaveBeenCalledWith(t.ent._id, expect.objectContaining({ level: 'warning' }));
    expect(t.invA.reminders[0]).toMatchObject({ kind: 'd1', channels: ['email', 'painel', 'whatsapp'] });
  });

  it('número inválido não liga o WhatsApp', async () => {
    const t = setup(); const n = notices(t);
    await expect(n.svc.save(eid, { whatsapp: '123', whatsappOn: true })).rejects.toMatchObject({ response: { code: 'WHATSAPP_INVALID' } });
    expect(await n.svc.save(eid, { whatsapp: '(81) 99876-5432', whatsappOn: true })).toMatchObject({ whatsapp: '5581998765432', whatsappOn: true });
  });
});
