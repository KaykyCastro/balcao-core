import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { MercadoPagoClient } from './mercadopago.client';
import { pkceChallenge, pkceVerifier } from '../store/store.service';

describe('OAuth do Mercado Pago com PKCE', () => {
  beforeAll(() => { process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString('base64'); process.env.JWT_SECRET ??= 'x'.repeat(40); });

  it('code_verifier: 64 caracteres permitidos, igual para o mesmo state, diferente para outro', () => {
    const v = pkceVerifier('6af3.1794355895319.abc');
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(v).toHaveLength(64);
    expect(pkceVerifier('6af3.1794355895319.abc')).toBe(v);
    expect(pkceVerifier('6af3.1794355895319.abd')).not.toBe(v);
  });

  it('code_challenge S256 = BASE64URL(SHA256(verifier)) (exemplo do RFC 7636)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const v = pkceVerifier('s');
    expect(pkceChallenge(v)).toBe(createHash('sha256').update(v).digest('base64url'));
  });

  it('link leva code_challenge e S256; a troca do código leva o code_verifier', async () => {
    const mp = new MercadoPagoClient(new ConfigService({ MP_CLIENT_ID: '8864762014862583', MP_CLIENT_SECRET: 's', MP_REDIRECT_URI: 'https://usebalcao.com/app/loja/mercadopago', MP_ACCESS_TOKEN: 'APP_USR-plataforma' })); // a troca pelo SDK usa a credencial da plataforma (obrigatória em produção)
    const u = new URL(mp.authUrl('st', 'CHAL'));
    expect(u.searchParams.get('code_challenge')).toBe('CHAL');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('https://usebalcao.com/app/loja/mercadopago');
    let body: any;
    global.fetch = jest.fn(async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', user_id: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
    await mp.exchangeCode('CODE', 'VERIF');
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'CODE', code_verifier: 'VERIF' });
  });
});
