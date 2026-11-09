import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { CODE_TTL_MS, maskEmail, MAX_ATTEMPTS, MAX_WRONG_TOTAL, TwoFactorService } from './two-factor.service';
import { GoogleService, pkceChallenge } from './google.service';

const SECRET = 'x'.repeat(40);
const cfg = (o: Record<string, string> = {}) => ({ get: (k: string) => ({ JWT_SECRET: SECRET, ...o })[k], getOrThrow: (k: string) => ({ JWT_SECRET: SECRET, ...o })[k] }) as any;
const EID = '507f1f77bcf86cd799439011';
const ent = { _id: EID, email: 'kayky@gmail.com', tokenVersion: 3 };

/** Coleção em memória com só o que o serviço usa. */
function fakeModel() {
  const docs: any[] = [];
  const match = (d: any, f: any) => Object.entries(f).every(([k, v]: [string, any]) =>
    v && typeof v === 'object' && '$gt' in v ? d[k] > v.$gt : String(d[k]) === String(v));
  return {
    docs,
    create: jest.fn(async (d: any) => { const doc = { _id: String(docs.length + 1), attempts: 0, wrongTotal: 0, sends: 1, ...d }; docs.push(doc); return doc; }),
    findOne: jest.fn(async (f: any) => docs.find((d) => match(d, f)) ?? null),
    findOneAndUpdate: jest.fn(async (f: any, u: any) => { const d = docs.find((x) => match(x, f)); if (!d) return null; for (const [k, v] of Object.entries(u.$inc ?? {})) d[k] += v as number; return d; }),
    updateOne: jest.fn(async (f: any, u: any) => { const d = docs.find((x) => match(x, f)); if (d) { Object.assign(d, u.$set ?? {}); for (const [k, v] of Object.entries(u.$inc ?? {})) d[k] += v as number; } }),
    deleteOne: jest.fn(async (f: any) => { const i = docs.findIndex((x) => match(x, f)); if (i >= 0) docs.splice(i, 1); }),
    findOneAndDelete: jest.fn(async (f: any) => { const i = docs.findIndex((x) => match(x, f)); return i >= 0 ? docs.splice(i, 1)[0] : null; }),
  };
}

function setup() {
  const model = fakeModel();
  const mail = { send: jest.fn(async () => undefined) };
  const svc = new TwoFactorService(model as any, mail as any, new JwtService({}), cfg());
  const lastCode = () => (mail.send.mock.calls.at(-1) as any)[2].match(/\n(\d{6})\n/)[1] as string;
  return { svc, model, mail, lastCode };
}

describe('verificação em duas etapas', () => {
  it('envia 6 dígitos por e-mail e guarda só hashes (nem o identificador nem o código em claro)', async () => {
    const { svc, model, mail, lastCode } = setup();
    const r = await svc.start(ent, 'login', 'web');
    expect(r.challenge).toMatch(/^[a-f0-9]{64}$/);
    expect(r.emailHint).toBe('k***y@gmail.com');
    expect(mail.send).toHaveBeenCalledWith('kayky@gmail.com', expect.stringContaining(lastCode()), expect.any(String));
    const saved = JSON.stringify(model.docs[0]);
    expect(saved).not.toContain(r.challenge);
    expect(saved).not.toContain(`"${lastCode()}"`);
    expect(model.docs[0].idHash).toBe(createHash('sha256').update(r.challenge).digest('hex'));
    const ttl = model.docs[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(CODE_TTL_MS - 2000);
  });

  it('código certo abre uma vez só (uso único)', async () => {
    const { svc, lastCode } = setup();
    const { challenge } = await svc.start(ent, 'register', 'web');
    const code = lastCode();
    await expect(svc.verify(challenge, code, 'web')).resolves.toEqual({ enterpriseId: EID, purpose: 'register' });
    await expect(svc.verify(challenge, code, 'web')).rejects.toMatchObject({ response: { code: 'CODE_EXPIRED' } });
  });

  it('desafio do site não vale no app (e vice-versa)', async () => {
    const { svc, lastCode } = setup();
    const { challenge } = await svc.start(ent, 'login', 'web');
    await expect(svc.verify(challenge, lastCode(), 'mobile')).rejects.toMatchObject({ response: { code: 'CODE_EXPIRED' } });
  });

  it(`código errado conta tentativas e, na ${MAX_ATTEMPTS}ª, derruba o desafio`, async () => {
    const { svc, lastCode } = setup();
    const { challenge } = await svc.start(ent, 'login', 'web');
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    for (let i = 1; i < MAX_ATTEMPTS; i++) await expect(svc.verify(challenge, wrong, 'web')).rejects.toMatchObject({ response: { code: 'CODE_INVALID' } });
    await expect(svc.verify(challenge, wrong, 'web')).rejects.toMatchObject({ response: { code: 'CODE_LOCKED' } });
    await expect(svc.verify(challenge, lastCode(), 'web')).rejects.toMatchObject({ response: { code: 'CODE_EXPIRED' } }); // nem o certo vale mais
  });

  it(`reenviar o código não dá mais chances: no ${MAX_WRONG_TOTAL}º erro somado, o desafio cai`, async () => {
    const { svc, model, lastCode } = setup();
    const { challenge } = await svc.start(ent, 'login', 'web');
    let wrongs = 0;
    const miss = async () => { const w = lastCode() === '000000' ? '111111' : '000000'; wrongs++; return svc.verify(challenge, w, 'web').catch((e) => e.response.code); };
    for (let round = 0; round < 3 && model.docs.length; round++) {
      for (let i = 0; i < MAX_ATTEMPTS - 1 && wrongs < MAX_WRONG_TOTAL - 1; i++) expect(await miss()).toBe('CODE_INVALID');
      if (wrongs >= MAX_WRONG_TOTAL - 1) break;
      model.docs[0].lastSentAt = new Date(Date.now() - 61_000);
      await svc.resend(challenge, async () => ent.email); // zera as tentativas do código, não o total
    }
    expect(wrongs).toBe(MAX_WRONG_TOTAL - 1);
    expect(await miss()).toBe('CODE_LOCKED');
    expect(model.docs).toHaveLength(0);
  });

  it('recusa formatos inválidos sem consultar o banco', async () => {
    const { svc, model } = setup();
    await expect(svc.verify('../x', '123456', 'web')).rejects.toMatchObject({ response: { code: 'CODE_INVALID' } });
    await expect(svc.verify('a'.repeat(64), '12345', 'web')).rejects.toMatchObject({ response: { code: 'CODE_INVALID' } });
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('reenvio: espera 60 s; depois o código antigo deixa de valer e o novo vale', async () => {
    const { svc, model, lastCode } = setup();
    const { challenge } = await svc.start(ent, 'login', 'web');
    const first = lastCode();
    await expect(svc.resend(challenge, async () => ent.email)).rejects.toMatchObject({ response: { code: 'RESEND_WAIT' } });
    model.docs[0].lastSentAt = new Date(Date.now() - 61_000);
    await svc.resend(challenge, async () => ent.email);
    const second = lastCode();
    if (first !== second) await expect(svc.verify(challenge, first, 'web')).rejects.toMatchObject({ response: { code: 'CODE_INVALID' } });
    await expect(svc.verify(challenge, second, 'web')).resolves.toMatchObject({ enterpriseId: EID });
  });

  it('aparelho confiável: vale para a mesma empresa até trocar a senha/"sair de todos"', () => {
    const { svc } = setup();
    const t = svc.issueTrust(ent);
    expect(svc.isTrusted(t, ent)).toBe(true);
    expect(svc.isTrusted(t, { ...ent, tokenVersion: 4 })).toBe(false); // senha trocada
    expect(svc.isTrusted(t, { ...ent, _id: '507f1f77bcf86cd799439012' })).toBe(false); // outra empresa
    expect(svc.isTrusted('lixo', ent)).toBe(false);
    expect(svc.isTrusted(null, ent)).toBe(false);
  });

  it('token de aparelho confiável não é aceito como sessão (segredo diferente do JWT_SECRET)', () => {
    const { svc } = setup();
    const t = svc.issueTrust(ent);
    expect(() => new JwtService({}).verify(t, { secret: SECRET })).toThrow();
  });

  it('mascara o e-mail', () => {
    expect(maskEmail('ab@x.com')).toBe('a***@x.com');
    expect(maskEmail('maria.silva@loja.com.br')).toBe('m***a@loja.com.br');
  });
});

describe('login com Google', () => {
  const CID = '123-abc.apps.googleusercontent.com';
  const g = () => new GoogleService(cfg({ GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: 's', APP_URL: 'https://api.loja.com' }), new JwtService({}));
  const idToken = (p: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`;
  const good = { iss: 'https://accounts.google.com', aud: CID, exp: Math.floor(Date.now() / 1000) + 600, sub: 'g-1', email: 'Kayky@Gmail.com', email_verified: true, name: 'Kayky' };

  it('desligado sem as chaves', () => {
    expect(new GoogleService(cfg(), new JwtService({})).enabled).toBe(false);
    expect(g().enabled).toBe(true);
  });

  it('URL de ida: PKCE S256, state no cookie assinado e redirect padrão na API', () => {
    const { url, cookie } = g().begin('web');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('https://api.loja.com/auth/google/callback');
    const st = g().readState(cookie, u.searchParams.get('state'));
    expect(st?.client).toBe('web');
    expect(pkceChallenge(st!.verifier)).toBe(u.searchParams.get('code_challenge'));
    expect(g().readState(cookie, 'outro-state')).toBeNull();
    expect(g().readState(null, u.searchParams.get('state'))).toBeNull();
  });

  it('id_token: aceita só emissor do Google, destinatário certo, válido e com e-mail confirmado', () => {
    expect(g().profileFromIdToken(idToken(good))).toEqual({ sub: 'g-1', email: 'kayky@gmail.com', name: 'Kayky' });
    expect(() => g().profileFromIdToken(idToken({ ...good, aud: 'outro' }))).toThrow();
    expect(() => g().profileFromIdToken(idToken({ ...good, iss: 'https://evil.com' }))).toThrow();
    expect(() => g().profileFromIdToken(idToken({ ...good, exp: 1 }))).toThrow();
    expect(() => g().profileFromIdToken(idToken({ ...good, email_verified: false }))).toThrow();
    expect(() => g().profileFromIdToken('nao-e-jwt')).toThrow();
  });

  it('app: o código de volta só vale com o verificador PKCE do próprio aparelho', () => {
    const verifier = 'v'.repeat(64);
    const code = g().mobileCode(EID, pkceChallenge(verifier));
    expect(g().readMobileCode(code, verifier)).toBe(EID);
    expect(() => g().readMobileCode(code, 'w'.repeat(64))).toThrow();
  });

  it('cadastro: token do app exige o verificador; token do site não aceita verificador', () => {
    const p = { sub: 'g-1', email: 'a@b.com', name: 'A' };
    const verifier = 'v'.repeat(64);
    const appT = g().signupToken(p, pkceChallenge(verifier));
    expect(g().readSignupToken(appT, verifier)).toEqual(p);
    expect(() => g().readSignupToken(appT)).toThrow();
    const webT = g().signupToken(p);
    expect(g().readSignupToken(webT)).toEqual(p);
    expect(() => g().readSignupToken(webT, verifier)).toThrow();
  });
});
