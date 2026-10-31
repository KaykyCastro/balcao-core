import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EID = '507f1f77bcf86cd799439011';

function setup(opts: { enterprise?: any; found?: any } = {}) {
  const jwt = { sign: jest.fn((_p: any, o?: any) => `tok-${o?.expiresIn ?? 'default'}`), decode: jest.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })) };
  const ent = opts.enterprise ?? { _id: EID, status: 'active', tokenVersion: 2, toObject: () => ({ _id: EID, name: 'Loja', email: 'a@b.com' }) };
  const enterprises = { findEnterpriseById: jest.fn(async () => ent), create: jest.fn(async () => ent) };
  const config = { get: jest.fn((k: string) => ({ JWT_MOBILE_EXPIRES_IN: '30d', FRONTEND_URL: 'https://app.loja.com', APP_URL: 'https://api.loja.com' } as any)[k]) };
  const handoffs = { create: jest.fn(async (d: any) => d), findOneAndDelete: jest.fn(async () => opts.found === undefined ? { enterpriseId: EID, path: '/app/vendas' } : opts.found) };
  const svc = new AuthService(jwt as any, enterprises as any, {} as any, config as any, handoffs as any);
  return { svc, jwt, enterprises, handoffs, config };
}

describe('app do celular', () => {
  it('login mobile devolve o token no corpo, com validade longa', async () => {
    const { svc, jwt } = setup();
    const r = await svc.loginMobile({ _id: EID, tokenVersion: 2, toObject: () => ({ _id: EID, name: 'Loja' }) } as any);
    expect(r.accessToken).toBe('tok-30d');
    expect(jwt.sign).toHaveBeenCalledWith({ sub: EID, tv: 2 }, { expiresIn: '30d' });
    expect(r.enterprise).toMatchObject({ id: EID, name: 'Loja' });
  });

  it('código da ponte: guarda só o hash, vale 60 s', async () => {
    const { svc, handoffs } = setup();
    const code = await svc.createHandoff(EID, '/app/vendas');
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    const saved = handoffs.create.mock.calls[0][0];
    expect(saved.codeHash).toBe(sha(code));
    expect(JSON.stringify(saved)).not.toContain(code);
    const ttl = saved.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55_000); expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('resgate apaga o código no mesmo passo (uso único) e abre sessão normal', async () => {
    const { svc, handoffs } = setup();
    const code = 'a'.repeat(64);
    const r = await svc.redeemHandoff(code);
    expect(handoffs.findOneAndDelete).toHaveBeenCalledWith({ codeHash: sha(code), expiresAt: { $gt: expect.any(Date) } });
    expect(r?.path).toBe('/app/vendas');
    expect(r?.session.accessToken).toBe('tok-default'); // sessão do navegador: validade normal
  });

  it('recusa código mal formado, vencido/usado ou de conta suspensa', async () => {
    expect(await setup().svc.redeemHandoff('../../etc')).toBeNull();
    expect(await setup({ found: null }).svc.redeemHandoff('b'.repeat(64))).toBeNull();
    const sus = { _id: EID, status: 'suspended', toObject: () => ({}) };
    expect(await setup({ enterprise: sus }).svc.redeemHandoff('c'.repeat(64))).toBeNull();
  });

  it('rota de resgate: válido -> cookie + tela de vendas embutida; inválido -> login', async () => {
    const res = () => { const r: any = { headers: {}, setHeader: jest.fn((k, v) => { r.headers[k] = v; }), cookie: jest.fn(), redirect: jest.fn() }; return r; };
    const { svc, config } = setup();
    const ctl = new AuthController(svc, {} as any, config as any);
    const ok = res();
    await ctl.redeem('d'.repeat(64), ok);
    expect(ok.cookie).toHaveBeenCalledWith('erp_session', 'tok-default', expect.objectContaining({ httpOnly: true }));
    expect(ok.redirect).toHaveBeenCalledWith(302, 'https://app.loja.com/app/vendas?embed=app');
    expect(ok.headers['Referrer-Policy']).toBe('no-referrer');

    const bad = res();
    await new AuthController(setup({ found: null }).svc, {} as any, config as any).redeem('e'.repeat(64), bad);
    expect(bad.cookie).not.toHaveBeenCalled();
    expect(bad.redirect).toHaveBeenCalledWith(302, 'https://app.loja.com/entrar');
  });

  it('pedido do link usa a URL pública da API', async () => {
    const { svc, config } = setup();
    const ctl = new AuthController(svc, {} as any, config as any);
    const r = await ctl.handoff(EID, {}, { protocol: 'http', get: () => 'x' } as any);
    expect(r.url).toMatch(/^https:\/\/api\.loja\.com\/auth\/handoff\/[a-f0-9]{64}$/);
  });
});
