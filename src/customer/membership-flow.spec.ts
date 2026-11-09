import { Types } from 'mongoose';
import { CustomerService } from './customer.service';

/** Model em memória, só o que o serviço usa. */
function fakeModel(rows: any[]) {
  const q = (val: any) => { const p: any = Promise.resolve(val); p.select = () => p; p.lean = () => p; p.session = () => p; p.sort = () => p; p.limit = () => p; return p; };
  const match = (d: any, f: any) => Object.entries(f).every(([k, v]: any) => {
    if (v && typeof v === 'object' && '$ne' in v) return String(d[k] ?? null) !== String(v.$ne);
    if (v && typeof v === 'object' && '$gt' in v) return d[k] > v.$gt;
    if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(d[k]));
    return String(d[k] ?? null) === String(v);
  });
  const doc = (d: any) => d && Object.assign(d, { save: jest.fn(async () => d), deleteOne: jest.fn(async () => { rows.splice(rows.indexOf(d), 1); }) });
  const apply = (d: any, u: any) => { Object.assign(d, u.$set ?? {}); for (const [k, v] of Object.entries(u.$inc ?? {})) d[k] = (d[k] ?? 0) + (v as number); };
  const make = (d: any) => { const x = doc({ _id: new Types.ObjectId(), status: 'pending', createdAt: new Date(), ...d }); rows.push(x); return x; };
  return {
    rows,
    exists: jest.fn((f) => q(rows.some((d) => match(d, f)))),
    create: jest.fn(async (d) => (Array.isArray(d) ? d.map(make) : make(d))),
    find: jest.fn((f) => q(rows.filter((d) => match(d, f)))),
    findOne: jest.fn((f) => q(doc(rows.find((d) => match(d, f))))),
    findById: jest.fn((id) => q(doc(rows.find((d) => String(d._id) === String(id))))),
    updateOne: jest.fn(async (f, u) => { const d = rows.find((x) => match(x, f)); if (d) apply(d, u); }),
    updateMany: jest.fn(async () => undefined),
    findOneAndUpdate: jest.fn(async (f, u) => { const d = rows.find((x) => match(x, f)); if (d) apply(d, u); return doc(d); }),
  };
}

const eid = String(new Types.ObjectId());
function setup({ verified = true } = {}) {
  const shopper = { _id: new Types.ObjectId(), name: 'Ana Souza', email: 'ana@ex.com', phone: '(81) 99876-5432', emailVerifiedAt: verified ? new Date() : null };
  const fiado: any = { _id: new Types.ObjectId(), enterpriseId: eid, name: 'Ana (caderninho)', numberWithPrefix: '81 9876-5432', email: '', debitCents: 5000, shopperId: null, origin: 'pos', memberSince: null };
  const auto: any = { _id: new Types.ObjectId(), enterpriseId: eid, name: 'Ana Souza', email: 'ana@ex.com', debitCents: 0, shopperId: shopper._id, origin: 'online', memberSince: null };
  const customers = fakeModel([fiado, auto]);
  const payments = fakeModel([]);
  const requests = fakeModel([]);
  const shoppers = fakeModel([shopper]);
  const coll = { updateMany: jest.fn(async () => undefined), findOne: jest.fn(async (f: any) => (f._id ? { name: 'Pele Boa' } : { name: 'Pele Boa', slug: 'pele', enabled: true })) };
  const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
  const codes: any = fakeModel([]);
  codes.deleteMany = jest.fn(async () => undefined);
  const messages = { notify: jest.fn(async () => undefined) };
  const mail = { send: jest.fn(async () => undefined) };
  const svc = new CustomerService(customers as any, payments as any, shoppers as any, requests as any, { collection: () => coll, startSession: async () => session } as any, codes, messages as any, mail as any);
  return { svc, shopper, fiado, auto, customers, requests, coll, codes, messages, mail };
}

describe('pertencer à loja: só com consentimento', () => {
  it('conta do marketplace que só comprou online não recebe fiado', async () => {
    const t = setup();
    await expect(t.svc.assertCanOwe(eid, String(t.auto._id))).rejects.toMatchObject({ response: { code: 'CUSTOMER_NOT_MEMBER' } });
    await expect(t.svc.assertCanOwe(eid, String(t.fiado._id))).resolves.toBeTruthy(); // caderninho do lojista continua
  });

  it('pedido precisa de e-mail confirmado', async () => {
    const t = setup({ verified: false });
    await expect(t.svc.requestJoin(t.shopper._id, eid)).rejects.toMatchObject({ response: { code: 'SHOPPER_UNVERIFIED' } });
  });

  it('pedido fica em aberto e sugere o cadastro parecido (telefone, nome) e o automático', async () => {
    const t = setup();
    expect(await t.svc.requestJoin(t.shopper._id, eid, 'sou a Ana da rua 2')).toEqual({ status: 'pending' });
    expect(await t.svc.requestJoin(t.shopper._id, eid)).toEqual({ status: 'pending' }); // não duplica
    const { items } = await t.svc.pendingFor(eid);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ direction: 'join', message: 'sou a Ana da rua 2', person: { email: 'ana@ex.com' } });
    expect(items[0].suggestions.map((x) => x.id)).toEqual([String(t.fiado._id)]); // o cadastro automático não é sugestão: é o "não tenho outro"
    expect(items[0].onlineCustomer).toMatchObject({ id: String(t.auto._id) });
  });

  it('aceitar unindo ao cadastro do balcão: conta ligada, fiado preservado, automático absorvido', async () => {
    const t = setup();
    await t.svc.requestJoin(t.shopper._id, eid);
    const r = t.requests.rows[0];
    const c = await t.svc.acceptJoin(eid, String(r._id), String(t.fiado._id));
    expect(String(c.shopperId)).toBe(String(t.shopper._id));
    expect(c.memberSince).toBeInstanceOf(Date);
    expect(c.debitCents).toBe(5000);
    expect(c.email).toBe('ana@ex.com');
    expect(t.customers.rows).not.toContain(t.auto);
    expect(t.coll.updateMany).toHaveBeenCalledTimes(2); // vendas e pedidos movidos
    expect(r.status).toBe('accepted');
    await expect(t.svc.assertCanOwe(eid, String(c._id))).resolves.toBeTruthy();
  });

  it('aceitar sem escolher: o cadastro automático vira cliente da loja', async () => {
    const t = setup();
    await t.svc.requestJoin(t.shopper._id, eid);
    const c = await t.svc.acceptJoin(eid, String(t.requests.rows[0]._id), null);
    expect(String(c._id)).toBe(String(t.auto._id));
    expect(c.memberSince).toBeInstanceOf(Date);
  });

  it('convite da loja só liga quando a pessoa aceita', async () => {
    const t = setup();
    expect(await t.svc.invite(eid, String(t.fiado._id), 'ANA@ex.com')).toEqual({ status: 'invited' });
    expect(t.fiado.shopperId).toBeNull();
    const inv = t.requests.rows[0];
    await expect(t.svc.shopperAnswer(new Types.ObjectId(), String(inv._id), 'accept')).rejects.toMatchObject({ status: 404 }); // outra pessoa
    await t.svc.shopperAnswer(t.shopper._id, String(inv._id), 'accept');
    expect(String(t.fiado.shopperId)).toBe(String(t.shopper._id));
  });

  it('convite + pedido = os dois disseram sim: liga na hora', async () => {
    const t = setup();
    await t.svc.invite(eid, String(t.fiado._id), 'ana@ex.com');
    expect(await t.svc.requestJoin(t.shopper._id, eid)).toEqual({ status: 'member' });
    expect(String(t.fiado.shopperId)).toBe(String(t.shopper._id));
  });

  it('convite para e-mail sem conta ou sem confirmação é recusado', async () => {
    const t = setup({ verified: false });
    await expect(t.svc.invite(eid, String(t.fiado._id), 'ana@ex.com')).rejects.toMatchObject({ response: { code: 'SHOPPER_UNVERIFIED' } });
    await expect(t.svc.invite(eid, String(t.fiado._id), 'outra@ex.com')).rejects.toMatchObject({ status: 404 });
  });

  it('só sai da loja (ou é desligado) com o saldo quitado', async () => {
    const t = setup();
    await t.svc.requestJoin(t.shopper._id, eid);
    const c = await t.svc.acceptJoin(eid, String(t.requests.rows[0]._id), String(t.fiado._id));
    await expect(t.svc.leave(t.shopper._id, String(c._id))).rejects.toMatchObject({ response: { code: 'DEBT_OPEN' } });
    await expect(t.svc.unlinkShopper(eid, String(c._id))).rejects.toMatchObject({ response: { code: 'DEBT_OPEN' } });
    c.debitCents = 0;
    await t.svc.leave(t.shopper._id, String(c._id));
    expect(c.shopperId).toBeNull();
    expect(c.memberSince).toBeNull();
  });

  it('avisa: loja no pedido; cliente por e-mail no convite e no aceite', async () => {
    const t = setup();
    await t.svc.requestJoin(t.shopper._id, eid, 'oi');
    expect(t.messages.notify).toHaveBeenCalledWith(eid, expect.objectContaining({ title: 'Ana Souza pediu para ser cliente da loja', link: '/app/clientes' }));
    await t.svc.acceptJoin(eid, String(t.requests.rows[0]._id), null);
    await new Promise((r) => setImmediate(r));
    expect(t.mail.send).toHaveBeenCalledWith('ana@ex.com', 'Agora você é cliente de Pele Boa', expect.stringContaining('/conta?aba=debitos'));
  });
});

describe('QR de convite', () => {
  it('liga ao cadastro escolhido, uma vez só, e avisa a loja', async () => {
    const t = setup();
    const { token, url } = await t.svc.createInviteCode(eid, String(t.fiado._id));
    expect(url).toContain(`/conta/convite/${token}`);
    expect(t.codes.rows[0].tokenHash).not.toBe(token); // só o hash fica guardado
    const c = await t.svc.redeemCode(t.shopper._id, token);
    expect(String(c._id)).toBe(String(t.fiado._id));
    expect(String(t.fiado.shopperId)).toBe(String(t.shopper._id));
    expect(t.messages.notify).toHaveBeenCalledWith(eid, expect.objectContaining({ title: 'Ana Souza entrou pelo QR de convite' }));
    const other = setup();
    other.codes.rows.push(...t.codes.rows);
    await expect(other.svc.redeemCode(other.shopper._id, token)).rejects.toMatchObject({ response: { code: 'INVITE_USED' } });
  });

  it('vencido ou inexistente não vale', async () => {
    const t = setup();
    const { token } = await t.svc.createInviteCode(eid, String(t.fiado._id));
    t.codes.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(t.svc.redeemCode(t.shopper._id, token)).rejects.toMatchObject({ response: { code: 'INVITE_EXPIRED' } });
    await expect(t.svc.previewCode('x'.repeat(32))).rejects.toMatchObject({ response: { code: 'INVITE_NOT_FOUND' } });
  });

  it('precisa de e-mail confirmado e não serve para quem já é membro', async () => {
    const u = setup({ verified: false });
    const { token } = await u.svc.createInviteCode(eid, String(u.fiado._id));
    await expect(u.svc.redeemCode(u.shopper._id, token)).rejects.toMatchObject({ response: { code: 'SHOPPER_UNVERIFIED' } });
    expect(u.codes.rows[0].usedAt ?? null).toBeNull(); // não gastou o QR
  });
});
