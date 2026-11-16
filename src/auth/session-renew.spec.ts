import { shouldRenew } from './session-renew.interceptor';
import { webSessionLife } from './session-cookie';

const H = 3600, D = 24 * H;
describe('sessão do site', () => {
  it('lojista fica 30 dias; admin e colaborador ficam com a sessão curta', () => {
    const cfg = { get: (k: string) => ({ JWT_EXPIRES_IN: '8h' } as Record<string, string>)[k] };
    expect(webSessionLife(cfg, {})).toBe('30d');
    expect(webSessionLife(cfg, { admin: true })).toBe('8h');
    expect(webSessionLife(cfg, { staff: true })).toBe('8h');
  });

  it('renova com o uso, sem regravar o cookie a cada requisição', () => {
    const iat = 1_000_000;
    expect(shouldRenew(iat, iat + 30 * D, iat + 2 * H)).toBe(false);
    expect(shouldRenew(iat, iat + 30 * D, iat + D)).toBe(true); // 30 dias: renova uma vez por dia
    expect(shouldRenew(iat, iat + 8 * H, iat + H)).toBe(false);
    expect(shouldRenew(iat, iat + 8 * H, iat + 2 * H)).toBe(true); // 8 h: a cada 2 h
    expect(shouldRenew(iat, iat + 8 * H, iat + 9 * H)).toBe(false); // vencido não renova
  });
});
