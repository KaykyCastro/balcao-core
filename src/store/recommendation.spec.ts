import { interestProfile, rankCandidates, VISITOR_RE, type Candidate, type Interaction } from './recommendation.rules';

const now = new Date('2026-11-05T12:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * 864e5);
const ev = (productId: string, categoryId: string | null, kind: 'view' | 'like', days = 0, enterpriseId = 'lojaA'): Interaction => ({ productId, enterpriseId, categoryId, kind, at: ago(days) });
const cand = (id: string, categoryId: string | null, enterpriseId = 'lojaA', popularity = 0): Candidate => ({ id, enterpriseId, categoryId, popularity });

describe('recomendação do marketplace', () => {
  it('aceita só visitante aleatório de 32 hex (sem e-mail ou nome)', () => {
    expect(VISITOR_RE.test('a'.repeat(32))).toBe(true);
    expect(VISITOR_RE.test('fulano@email.com')).toBe(false);
    expect(VISITOR_RE.test('A'.repeat(32))).toBe(false);
  });

  it('curtir pesa mais que ver', () => {
    const p = interestProfile([ev('p1', 'batom', 'like'), ev('p2', 'perfume', 'view'), ev('p3', 'perfume', 'view')], now);
    expect(p.categories[0][0]).toBe('batom');
  });

  it('interesse antigo perde força com o tempo', () => {
    const p = interestProfile([ev('p1', 'velho', 'like', 30), ev('p2', 'novo', 'view', 0)], now);
    expect(p.categories[0][0]).toBe('novo');
  });

  it('recomenda a categoria preferida e esconde o que a pessoa já viu', () => {
    const profile = interestProfile([ev('p1', 'batom', 'like'), ev('p2', 'batom', 'view')], now);
    const ids = rankCandidates([cand('p1', 'batom'), cand('x1', 'tenis', 'lojaB', 50), cand('p3', 'batom')], profile);
    expect(ids[0]).toBe('p3');
    expect(ids).not.toContain('p1');
  });

  it('sem histórico ordena pelo que está em alta', () => {
    const ids = rankCandidates([cand('a', null, 'l1', 1), cand('b', null, 'l2', 9), cand('c', null, 'l3', 4)], interestProfile([], now));
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('varia as lojas: 3 da mesma loja antes das outras, e completa com o resto', () => {
    const ids = rankCandidates([1, 2, 3, 4, 5].map((i) => cand(`a${i}`, null, 'lojaA', 10)).concat(cand('b1', null, 'lojaB', 1)), interestProfile([], now));
    expect(ids.slice(0, 4)).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(ids).toHaveLength(6);
  });

  it('respeita o limite', () => {
    const list = Array.from({ length: 30 }, (_, i) => cand(`p${i}`, null, `l${i}`, i));
    expect(rankCandidates(list, interestProfile([], now), 5)).toHaveLength(5);
  });
});
