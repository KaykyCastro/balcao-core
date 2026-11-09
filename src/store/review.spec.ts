import { canReview, distribution, reviewerName, summarize } from './review.rules';

describe('avaliações', () => {
  it('só pedido pago (ou entregue) pode ser avaliado', () => {
    expect(canReview('paid')).toBe(true);
    expect(canReview('delivered')).toBe(true);
    expect(canReview('pending_payment')).toBe(false);
    expect(canReview('cancelled')).toBe(false);
  });
  it('mostra só o primeiro nome e a inicial (privacidade)', () => {
    expect(reviewerName('ana maria souza')).toBe('Ana S.');
    expect(reviewerName('Joao')).toBe('Joao');
    expect(reviewerName('  ')).toBe('Cliente');
  });
  it('média com uma casa e distribuição por estrelas', () => {
    expect(summarize([5, 4, 4])).toEqual({ avg: 4.3, count: 3 });
    expect(summarize([])).toEqual({ avg: 0, count: 0 });
    expect(distribution([5, 5, 3, 1])).toEqual([2, 0, 1, 0, 1]);
  });
});
