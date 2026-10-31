import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth/auth.controller';
import { clearSessionCookie, jwtFromCookieOrBearer, readCookie, SESSION_COOKIE, setSessionCookie } from './auth/session-cookie';
import { CsrfGuard } from './common/guards/csrf.guard';

const cfg = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] }) as unknown as ConfigService;
const req = (headers: Record<string, string>, method = 'POST') => ({ headers, method });
const ctx = (r: unknown) => ({ switchToHttp: () => ({ getRequest: () => r }) }) as any;

describe('cookie de sessão', () => {
  it('lê o cookie certo entre vários e decodifica', () => {
    expect(readCookie(req({ cookie: `a=1; ${SESSION_COOKIE}=abc%2Edef; b=2` }), SESSION_COOKIE)).toBe('abc.def');
    expect(readCookie(req({ cookie: 'x_erp_session=zzz' }), SESSION_COOKIE)).toBeNull();
    expect(readCookie(req({}), SESSION_COOKIE)).toBeNull();
    expect(readCookie(req({ cookie: `${SESSION_COOKIE}=%E0%A4%A` }), SESSION_COOKIE)).toBeNull(); // percent-encoding quebrado
  });
  it('extrator: cookie primeiro, depois Bearer; nada válido => null', () => {
    expect(jwtFromCookieOrBearer(req({ cookie: `${SESSION_COOKIE}=C`, authorization: 'Bearer B' }) as any)).toBe('C');
    expect(jwtFromCookieOrBearer(req({ authorization: 'Bearer B' }) as any)).toBe('B');
    expect(jwtFromCookieOrBearer(req({ authorization: 'Basic abc' }) as any)).toBeNull();
    expect(jwtFromCookieOrBearer(req({}) as any)).toBeNull();
  });
  it('em produção: httpOnly, Secure, SameSite=Lax, path /', () => {
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as any;
    const exp = new Date(Date.now() + 1000);
    setSessionCookie(res, cfg({ NODE_ENV: 'production' }), 'tok', exp);
    expect(res.cookie).toHaveBeenCalledWith(SESSION_COOKIE, 'tok', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: exp });
    clearSessionCookie(res, cfg({ NODE_ENV: 'production' }));
    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });
  it('SameSite=None força Secure; valor inválido cai em Lax; domínio é opcional', () => {
    const res = { cookie: jest.fn() } as any;
    setSessionCookie(res, cfg({ COOKIE_SAMESITE: 'none', COOKIE_DOMAIN: '.x.com' }), 't', new Date());
    expect(res.cookie.mock.calls[0][2]).toMatchObject({ sameSite: 'none', secure: true, domain: '.x.com' });
    setSessionCookie(res, cfg({ COOKIE_SAMESITE: 'qualquer' }), 't', new Date());
    expect(res.cookie.mock.calls[1][2]).toMatchObject({ sameSite: 'lax', secure: false });
  });
  it('login grava o cookie e NÃO devolve o token no corpo', async () => {
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as any;
    const exp = new Date(Date.now() + 3600_000);
    const auth = { login: async () => ({ accessToken: 'SEGREDO', expiresAt: exp, enterprise: { id: '1', name: 'X', role: 'user' } }) } as any;
    const body = await new AuthController(auth, {} as any, cfg()).login({ user: {} }, {} as any, res);
    expect(res.cookie).toHaveBeenCalledWith(SESSION_COOKIE, 'SEGREDO', expect.objectContaining({ httpOnly: true, expires: exp }));
    expect(JSON.stringify(body)).not.toContain('SEGREDO');
    expect(body.enterprise).toMatchObject({ id: '1' });
  });
  it('logout apaga o cookie', () => {
    const res = { clearCookie: jest.fn() } as any;
    new AuthController({} as any, {} as any, cfg()).logout(res);
    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, expect.objectContaining({ httpOnly: true }));
  });
});

describe('CsrfGuard', () => {
  const g = new CsrfGuard(cfg({ CORS_ORIGIN: 'https://app.x.com, https://b.x.com/' }));
  const withCookie = { cookie: `${SESSION_COOKIE}=t` };
  it('leitura e requisições sem cookie de sessão passam', () => {
    expect(g.canActivate(ctx(req(withCookie, 'GET')))).toBe(true);
    expect(g.canActivate(ctx(req({}, 'POST')))).toBe(true); // login, webhook, integração com Bearer
  });
  it('escrita com cookie exige o cabeçalho X-Requested-With', () => {
    expect(() => g.canActivate(ctx(req(withCookie)))).toThrow(ForbiddenException);
    expect(() => g.canActivate(ctx(req({ ...withCookie, 'x-requested-with': 'XMLHttpRequest' })))).toThrow(ForbiddenException);
    expect(g.canActivate(ctx(req({ ...withCookie, 'x-requested-with': 'erp-web' })))).toBe(true);
  });
  it('Origin fora da lista é recusada; dentro da lista (com ou sem barra final) passa', () => {
    const h = { ...withCookie, 'x-requested-with': 'erp-web' };
    expect(() => g.canActivate(ctx(req({ ...h, origin: 'https://evil.com' })))).toThrow(ForbiddenException);
    expect(g.canActivate(ctx(req({ ...h, origin: 'https://app.x.com' })))).toBe(true);
    expect(g.canActivate(ctx(req({ ...h, origin: 'https://b.x.com' })))).toBe(true);
  });
  it('sem CORS_ORIGIN (dev) não confere a origem, mas o cabeçalho continua exigido', () => {
    const dev = new CsrfGuard(cfg());
    expect(dev.canActivate(ctx(req({ ...withCookie, 'x-requested-with': 'erp-web', origin: 'http://localhost:5173' })))).toBe(true);
    expect(() => dev.canActivate(ctx(req(withCookie)))).toThrow(ForbiddenException);
  });
});
