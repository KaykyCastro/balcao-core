import { BANNER_LINK_RE, isLive } from './market-banner.rules';

describe('banners do marketplace', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const d = (h: number) => new Date(now.getTime() + h * 3600_000);

  it('fica no ar só quando ativo e dentro do período', () => {
    expect(isLive({ active: true, startsAt: null, endsAt: null }, now)).toBe(true);
    expect(isLive({ active: false, startsAt: null, endsAt: null }, now)).toBe(false);
    expect(isLive({ active: true, startsAt: d(1), endsAt: null }, now)).toBe(false);
    expect(isLive({ active: true, startsAt: d(-1), endsAt: d(1) }, now)).toBe(true);
    expect(isLive({ active: true, startsAt: null, endsAt: d(-1) }, now)).toBe(false);
  });

  it('aceita caminho do site ou https, e recusa links perigosos', () => {
    for (const ok of ['', '/lojas', '/loja/pele-boa', '/lojas?segmento=perfumes', 'https://balcao.app/promo']) expect(BANNER_LINK_RE.test(ok)).toBe(true);
    for (const bad of ['//evil.com', 'javascript:alert(1)', 'http://inseguro.com', 'lojas', '/a b']) expect(BANNER_LINK_RE.test(bad)).toBe(false);
  });
});
