import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { ShopperService } from './shopper.service';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { sha256 } from '../common/secret-box';

/** Model em memória, só o que o serviço usa. */
function fakeModel(rows: any[]) {
  const q = (val: any) => { const p: any = Promise.resolve(val); p.select = () => p; p.lean = () => p; return p; };
  const match = (d: any, f: any) => Object.entries(f).every(([k, v]: any) => {
    if (v && typeof v === 'object' && '$gt' in v) return d[k] && d[k] > v.$gt;
    if (v && typeof v === 'object' && '$ne' in v) return String(d[k]) !== String(v.$ne);
    return String(d[k]) === String(v);
  });
  const doc = (d: any) => d && Object.assign(d, { save: jest.fn(async () => d), deleteOne: jest.fn(async () => { rows.splice(rows.indexOf(d), 1); }) });
  const apply = (d: any, u: any) => { Object.assign(d, u.$set ?? {}); for (const [k, v] of Object.entries(u.$inc ?? {})) d[k] = (d[k] ?? 0) + (v as number); };
  return {
    rows,
    exists: jest.fn(async (f) => rows.some((d) => match(d, f))),
    create: jest.fn(async (d) => { const x = doc({ _id: new Types.ObjectId(), tokenVersion: 0, addresses: [], emailVerifiedAt: null, ...d }); rows.push(x); return x; }),
    findOne: jest.fn((f) => q(doc(rows.find((d) => match(d, f))))),
    findById: jest.fn((id) => q(doc(rows.find((d) => String(d._id) === String(id))))),
    updateOne: jest.fn(async (f, u) => { const d = rows.find((x) => match(x, f)); if (d) apply(d, u); }),
    findOneAndUpdate: jest.fn(async (f, u) => { const d = rows.find((x) => match(x, f)); if (d) apply(d, u); return doc(d); }),
  };
}

function setup() {
  const model = fakeModel([]);
  const jwt = new JwtService({ secret: 'segredo-de-teste::shopper' });
  const mail = { send: jest.fn(async () => undefined) };
  const config: any = { get: (k: string) => (k === 'FRONTEND_URL' ? 'https://balcao.app' : undefined) };
  const orders = { find: () => ({ toArray: async () => [] }), updateMany: jest.fn(), deleteMany: jest.fn(), insertOne: jest.fn(async () => ({})) };
  const connection: any = { collection: () => orders, models: {} };
  const customers: any = { ensureForShopper: jest.fn() };
  const svc = new ShopperService(model as any, connection, jwt, config, mail as any, customers);
  return { svc, orders, model, jwt, mail };
}
const req = (token: string) => ({ headers: { cookie: `balcao_shopper=${token}` } });

describe('conta do comprador', () => {
  it('cadastro manda link de confirmação e o cookie abre a conta; e-mail repetido é recusado', async () => {
    const t = setup();
    const s = await t.svc.register({ acceptTerms: true, name: 'Ana', email: 'ana@ex.com', password: 'senha-forte-1', from: 'bella-moda' });
    expect(t.mail.send).toHaveBeenCalledWith('ana@ex.com', expect.any(String), expect.stringMatching(/https:\/\/balcao\.app\/conta\/verificar\/\S+\?loja=bella-moda/));
    expect(s.passwordHash).not.toBe('senha-forte-1');
    expect(String((await t.svc.fromRequest(req(t.svc.token(s))))!._id)).toBe(String(s._id));
    await expect(t.svc.register({ acceptTerms: true, name: 'Outra', email: 'ana@ex.com', password: 'xxxxxxxx' })).rejects.toMatchObject({ status: 409 });
  });

  it('token do lojista ou de outro tipo não vale como sessão do comprador', async () => {
    const t = setup();
    const s = await t.svc.register({ acceptTerms: true, name: 'Ana', email: 'ana@ex.com', password: 'senha-forte-1' });
    const merchant = new JwtService({ secret: 'segredo-de-teste' }).sign({ sub: String(s._id), v: 0, typ: 'shopper' });
    expect(await t.svc.fromRequest(req(merchant))).toBeNull();
    expect(await t.svc.fromRequest(req(t.jwt.sign({ sub: String(s._id), v: 0 })))).toBeNull();
    expect(await t.svc.fromRequest({ headers: {} })).toBeNull();
  });

  it('senha errada 5x bloqueia por um tempo; trocar a senha derruba as sessões antigas', async () => {
    const t = setup();
    const s = await t.svc.register({ acceptTerms: true, name: 'Ana', email: 'ana@ex.com', password: 'senha-forte-1' });
    const old = t.svc.token(s);
    for (let k = 0; k < 5; k++) await expect(t.svc.login('ana@ex.com', 'errada')).rejects.toMatchObject({ status: 401 });
    await expect(t.svc.login('ana@ex.com', 'senha-forte-1')).rejects.toMatchObject({ response: { code: 'LOCKED' } });
    t.model.rows[0].lockUntil = null;
    await t.svc.login('ana@ex.com', 'senha-forte-1');
    await expect(t.svc.changePassword(s._id, 'errada', 'nova-senha-123')).rejects.toMatchObject({ status: 400 });
    await t.svc.changePassword(s._id, 'senha-forte-1', 'nova-senha-123');
    expect(await t.svc.fromRequest(req(old))).toBeNull();
    await expect(t.svc.login('ana@ex.com', 'nova-senha-123')).resolves.toBeTruthy();
  });

  it('esqueci a senha: não revela se o e-mail existe; link redefine e confirma o e-mail', async () => {
    const t = setup();
    await t.svc.forgot('ninguem@ex.com');
    expect(t.mail.send).not.toHaveBeenCalled();
    await t.svc.register({ acceptTerms: true, name: 'Ana', email: 'ana@ex.com', password: 'senha-forte-1' });
    t.mail.send.mockClear();
    await t.svc.forgot('ana@ex.com');
    const token = (t.mail.send.mock.calls[0] as any[])[2].match(/redefinir\/(\S+)/)[1];
    const s = await t.svc.reset(token, 'outra-senha-9');
    expect(s.emailVerifiedAt).toBeInstanceOf(Date);
    await expect(t.svc.reset(token, 'mais-uma-123')).rejects.toMatchObject({ status: 404 });
  });

  it('confirmar e-mail funciona uma vez', async () => {
    const t = setup();
    await t.svc.register({ acceptTerms: true, name: 'Ana', email: 'ana@ex.com', password: 'senha-forte-1' });
    const token = (t.mail.send.mock.calls[0] as any[])[2].match(/verificar\/(\S+)/)[1];
    expect(t.model.rows[0].verifyHash).toBe(sha256(token));
    expect((await t.svc.verifyEmail(token)).emailVerifiedAt).toBeInstanceOf(Date);
    await expect(t.svc.verifyEmail(token)).rejects.toMatchObject({ status: 404 });
  });
});

// Vínculo entre cliente da loja e conta online: src/customer/membership-flow.spec.ts (só com consentimento).

describe('CSRF com o cookie do comprador', () => {
  const guard = new CsrfGuard({ get: () => '' } as any);
  const ctx = (headers: any, method = 'POST') => ({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) }) as any;
  it('POST com cookie do comprador exige o cabeçalho', () => {
    expect(() => guard.canActivate(ctx({ cookie: 'balcao_shopper=x' }))).toThrow();
    expect(guard.canActivate(ctx({ cookie: 'balcao_shopper=x', 'x-requested-with': 'erp-web' }))).toBe(true);
    expect(guard.canActivate(ctx({}))).toBe(true);
  });
});

void bcrypt;

describe('LGPD: conta do comprador', () => {
  it('guarda o aceite com as versões e exclui a conta só com a senha', async () => {
    const t = setup();
    const s = await t.svc.register({ acceptTerms: true, termsVersion: '2026-11-02', privacyVersion: '2026-11-02', name: 'Ana', email: 'ana@ex.com', password: 'senha-forte-1' });
    expect(t.model.rows[0].consents).toMatchObject({ termsVersion: '2026-11-02', privacyVersion: '2026-11-02', acceptedAt: expect.any(Date) });
    (t.model as any).deleteOne = jest.fn(async () => { t.model.rows.splice(0, 1); return { deletedCount: 1 }; });
    await expect(t.svc.deleteAccount(s._id, 'errada')).rejects.toMatchObject({ status: 400 });
    await t.svc.deleteAccount(s._id, 'senha-forte-1');
    expect(t.model.rows).toHaveLength(0);
    // fica a prova do atendimento, sem o e-mail completo
    const log = ((t as any).orders.insertOne as jest.Mock).mock.calls[0][0];
    expect(log).toMatchObject({ action: 'shopper.delete', meta: { by: 'titular', email: 'an***@ex.com' } });
  });
});
