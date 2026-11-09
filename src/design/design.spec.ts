import { designDenied, isLive } from './design.rules';

describe('acesso do admin ao design da loja (design.rules)', () => {
  const later = new Date(Date.now() + 3_600_000);
  it('só vale permitido/em andamento e dentro do prazo', () => {
    expect(isLive({ status: 'granted', expiresAt: later })).toBe(true);
    expect(isLive({ status: 'in_progress', expiresAt: later })).toBe(true);
    expect(isLive({ status: 'requested', expiresAt: later })).toBe(false);
    expect(isLive({ status: 'finished', expiresAt: later })).toBe(false);
    expect(isLive({ status: 'revoked', expiresAt: later })).toBe(false);
    expect(isLive({ status: 'granted', expiresAt: new Date(Date.now() - 1) })).toBe(false);
  });

  it('rotas de design passam; o resto da loja não', () => {
    expect(designDenied('GET', '/store-config', null)).toBeNull();
    expect(designDenied('PUT', '/store-config/page', { page: {} })).toBeNull();
    expect(designDenied('GET', '/product?limit=50', null)).toBeNull();
    for (const [m, p] of [['GET', '/sale'], ['GET', '/customer'], ['POST', '/product'], ['GET', '/orders'], ['GET', '/billing/summary'], ['PUT', '/enterprise/0123456789abcdef01234567'], ['GET', '/store-config/mercadopago/connect'], ['POST', '/store-config/coupons']]) {
      expect(designDenied(m, p, {})).toEqual(expect.any(String));
    }
  });

  it('em PUT /store-config só campos de aparência', () => {
    expect(designDenied('PUT', '/store-config', { theme: {}, logo: '', slides: [] })).toBeNull();
    expect(designDenied('PUT', '/store-config', { theme: {}, enabled: false })).toMatch(/enabled/);
    expect(designDenied('PUT', '/store-config', { shipping: {} })).toMatch(/shipping/);
  });

  it('não publica e só envia imagem/vídeo da loja', () => {
    expect(designDenied('PUT', '/store-config/page', { page: {}, publish: true })).toMatch(/lojista/);
    expect(designDenied('POST', '/uploads/presign', { kind: 'store' })).toBeNull();
    expect(designDenied('POST', '/uploads/presign', { kind: 'product' })).toEqual(expect.any(String));
  });
});
