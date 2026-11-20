import { collaborative, interestProfile, profileSummary, rankCandidates, tokens, VISITOR_RE, type Candidate, type EventKind, type Interaction } from './recommendation.rules';

const now = new Date('2026-11-05T12:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * 864e5);
const ev = (productId: string, categoryId: string | null, kind: EventKind, days = 0, enterpriseId = 'lojaA', extra: Partial<Interaction> = {}): Interaction => ({ productId, enterpriseId, categoryId, kind, at: ago(days), ...extra });
const cand = (id: string, categoryId: string | null, enterpriseId = 'lojaA', popularity = 0, extra: Partial<Candidate> = {}): Candidate => ({ id, enterpriseId, categoryId, popularity, ...extra });
const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

describe('recomendação do marketplace', () => {
  it('aceita só visitante aleatório de 32 hex (sem e-mail ou nome)', () => {
    expect(VISITOR_RE.test('a'.repeat(32))).toBe(true);
    expect(VISITOR_RE.test('fulano@email.com')).toBe(false);
    expect(VISITOR_RE.test('A'.repeat(32))).toBe(false);
  });

  it('curtir pesa mais que ver, e pôr no carrinho mais que curtir', () => {
    expect(top(interestProfile([ev('p1', 'batom', 'like'), ev('p2', 'perfume', 'view'), ev('p3', 'perfume', 'view')], now).categories)).toBe('batom');
    expect(top(interestProfile([ev('p1', 'batom', 'like'), ev('p2', 'tenis', 'cart')], now).categories)).toBe('tenis');
  });

  it('interesse antigo perde força com o tempo', () => {
    expect(top(interestProfile([ev('p1', 'velho', 'like', 30), ev('p2', 'novo', 'view', 0)], now).categories)).toBe('novo');
  });

  it('palavras: sem acento, sem as genéricas e sem números', () => {
    expect(tokens('Vestido Midi de Linho 100% - Tamanho M')).toEqual(['vestido', 'midi', 'linho']);
    expect(tokens('Tênis de corrida')).toEqual(['tenis', 'corrida']);
  });

  it('recomenda a categoria preferida e esconde o que a pessoa já viu', () => {
    const profile = interestProfile([ev('p1', 'batom', 'like'), ev('p2', 'batom', 'view')], now);
    const ids = rankCandidates([cand('p1', 'batom'), cand('x1', 'tenis', 'lojaB', 50), cand('p3', 'batom')], profile, { now });
    expect(ids[0]).toBe('p3');
    expect(ids).not.toContain('p1');
  });

  it('acha parecidos pelo nome em outra loja e outra categoria', () => {
    const profile = interestProfile([ev('p1', 'roupas', 'like', 0, 'lojaA', { name: 'Vestido longo floral' })], now);
    const ids = rankCandidates([cand('x', 'outra', 'lojaB', 0, { name: 'Caneca de cerâmica' }), cand('y', 'outra2', 'lojaC', 0, { name: 'Vestido curto floral' })], profile, { now });
    expect(ids[0]).toBe('y');
  });

  it('prefere a faixa de preço que a pessoa costuma olhar', () => {
    const profile = interestProfile([ev('p1', 'c', 'view', 0, 'l', { priceCents: 5000 }), ev('p2', 'c', 'view', 0, 'l', { priceCents: 6000 })], now);
    expect(profile.price).not.toBeNull();
    const ids = rankCandidates([cand('caro', 'c', 'l', 0, { priceCents: 90000 }), cand('perto', 'c', 'l', 0, { priceCents: 5500 })], profile, { now });
    expect(ids[0]).toBe('perto');
    const r = profileSummary(profile).price!;
    expect(r.minCents).toBeLessThan(5500); expect(r.maxCents).toBeGreaterThan(5500);
  });

  it('colaborativo: o que pessoas parecidas viram sobe na lista', () => {
    const c = collaborative(new Set(['a', 'b']), [
      { visitorId: 'v1', productId: 'a', kind: 'view' }, { visitorId: 'v1', productId: 'b', kind: 'view' }, { visitorId: 'v1', productId: 'z', kind: 'cart' },
      { visitorId: 'v3', productId: 'a', kind: 'view' }, { visitorId: 'v3', productId: 'z', kind: 'view' }, { visitorId: 'v3', productId: 's', kind: 'view' },
      { visitorId: 'v2', productId: 'q', kind: 'like' }, // não tem nada em comum: não conta
    ]);
    expect(c.has('s')).toBe(false); // só uma pessoa parecida viu: não é padrão
    expect(c.get('z')).toBe(1);
    expect(c.has('q')).toBe(false);
    expect(c.has('a')).toBe(false);
    const profile = interestProfile([ev('a', 'x', 'view'), ev('b', 'x', 'view')], now);
    const ids = rankCandidates([cand('w', 'y', 'l2'), cand('z', 'y', 'l2')], profile, { collab: c, now });
    expect(ids[0]).toBe('z');
  });

  it('sem histórico ordena pelo que está em alta', () => {
    const ids = rankCandidates([cand('a', null, 'l1', 1), cand('b', null, 'l2', 9), cand('c', null, 'l3', 4)], interestProfile([], now), { now });
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('varia as lojas: 3 da mesma loja antes das outras, e completa com o resto', () => {
    const ids = rankCandidates([1, 2, 3, 4, 5].map((i) => cand(`a${i}`, `c${i}`, 'lojaA', 10)).concat(cand('b1', null, 'lojaB', 1)), interestProfile([], now), { now });
    expect(ids.slice(0, 4)).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(ids).toHaveLength(6);
  });

  it('vitrine completa (excludeSeen: false): o já visto vai para o fim, não some', () => {
    const profile = interestProfile([ev('p1', 'batom', 'like')], now);
    const ids = rankCandidates([cand('p1', 'batom'), cand('p2', 'batom', 'l2'), cand('p3', 'outra', 'l3')], profile, { excludeSeen: false, now });
    expect(ids).toHaveLength(3);
    expect(ids[ids.length - 1]).toBe('p1');
  });

  it('gosto claro vem antes de variar, e a faixa pessoal não completa com o que não combina', () => {
    const profile = interestProfile([ev('p0', 'perfume', 'cart', 0, 'aroma', { name: 'Colônia cítrica', priceCents: 9000 })], now);
    const list = [1, 2, 3, 4, 5].map((i) => cand(`a${i}`, 'perfume', 'aroma', 0, { name: `Colônia ${i}`, priceCents: 9000 }))
      .concat(cand('t1', 'tenis', 'passo', 50, { name: 'Tênis de corrida', priceCents: 30000 }));
    const ids = rankCandidates(list, profile, { now, minShare: 0.45, keep: 2 });
    expect(ids.slice(0, 5).every((x) => x.startsWith('a'))).toBe(true);
    expect(ids).not.toContain('t1');
  });

  it('respeita o limite', () => {
    const list = Array.from({ length: 30 }, (_, i) => cand(`p${i}`, null, `l${i}`, i));
    expect(rankCandidates(list, interestProfile([], now), { limit: 5, now })).toHaveLength(5);
  });
});
