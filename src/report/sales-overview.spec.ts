import { brDay, salesOverview } from './sales-overview.rules';

const at = (iso: string) => new Date(iso);
describe('gestão de vendas: resumo do período', () => {
  it('separa balcão por forma (só o dinheiro novo), online, canceladas, trocas e correções', () => {
    const r = salesOverview([
      { status: 'completed', paymentMethod: 'cash', totalCents: 10000, createdAt: at('2026-11-18T15:00:00Z') },
      { status: 'completed', paymentMethod: 'pix', totalCents: 8000, creditCents: 3000, createdAt: at('2026-11-18T16:00:00Z'), paymentEdits: [{}] },
      { status: 'completed', paymentMethod: 'exchange', totalCents: 5000, exchangeCents: 5000, createdAt: at('2026-11-19T13:00:00Z') },
      { channel: 'online', status: 'completed', paymentMethod: 'online', totalCents: 20000, createdAt: at('2026-11-19T14:00:00Z') },
      { status: 'cancelled', paymentMethod: 'card', totalCents: 4000, createdAt: at('2026-11-19T14:00:00Z') },
    ], [{ returnedCents: 5000, newCents: 5000, creditCents: 0, refundCents: 0 }], '2026-11-18', '2026-11-19');
    expect(r.pos).toMatchObject({ count: 3, totalCents: 23000, coveredCents: 8000, byMethod: { cash: 10000, pix: 5000, card: 0, other: 0, fiado: 0 } });
    expect(r.online).toEqual({ count: 1, totalCents: 20000 });
    expect(r.cancelled).toEqual({ count: 1, totalCents: 4000 });
    expect(r.exchanges.count).toBe(1);
    expect(r.editedCount).toBe(1);
    expect(r.totalCents).toBe(43000);
    expect(r.days).toEqual([{ day: '2026-11-18', posCents: 18000, onlineCents: 0 }, { day: '2026-11-19', posCents: 5000, onlineCents: 20000 }]);
  });

  it('dia de Brasília: 01h UTC ainda é o dia anterior', () => {
    expect(brDay(at('2026-11-19T01:00:00Z'))).toBe('2026-11-18');
  });
});
