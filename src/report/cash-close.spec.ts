import { dayOf, dayRange, daySummary, type DaySale } from './cash-close.rules';

const at = (iso: string) => new Date(iso);
const sale = (p: Partial<DaySale>): DaySale => ({ paymentMethod: 'cash', status: 'completed', totalCents: 1000, createdAt: at('2026-11-14T15:00:00Z'), ...p });

describe('fechamento de caixa', () => {
  it('o dia vira à meia-noite de Brasília, não à meia-noite UTC', () => {
    expect(dayOf(at('2026-11-15T02:30:00Z'))).toBe('2026-11-14');
    expect(dayOf(at('2026-11-15T03:00:00Z'))).toBe('2026-11-15');
    const r = dayRange('2026-11-14', at('2026-11-15T12:00:00Z'));
    expect(r.from.toISOString()).toBe('2026-11-14T03:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-11-15T03:00:00.000Z');
  });

  it('recusa data inválida, futura ou antiga demais', () => {
    const now = at('2026-11-15T12:00:00Z');
    expect(() => dayRange('2026-02-30', now)).toThrow();
    expect(() => dayRange('15/11/2026', now)).toThrow();
    expect(() => dayRange('2026-11-16', now)).toThrow();
    expect(() => dayRange('2023-01-01', now)).toThrow();
    expect(() => dayRange('2026-11-15', now)).not.toThrow();
  });

  it('separa o que entrou no caixa, o que foi pago pela internet e o fiado', () => {
    const s = daySummary('2026-11-14', [
      sale({ paymentMethod: 'cash', totalCents: 5000 }),
      sale({ paymentMethod: 'pix', totalCents: 3000 }),
      sale({ paymentMethod: 'card', totalCents: 2000, discountCents: 200 }),
      sale({ paymentMethod: 'online', totalCents: 9000 }),
      sale({ paymentMethod: 'fiado', totalCents: 1500 }),
      sale({ paymentMethod: 'cash', totalCents: 700, status: 'cancelled' }),
    ], [{ method: 'cash', amountCents: 800 }, { method: 'pix', amountCents: 400 }], 10000);

    expect(s.sales).toMatchObject({ count: 5, revenueCents: 20500, discountCents: 200, cancelledCount: 1, cancelledCents: 700 });
    expect(s.drawer.find((d) => d.method === 'cash')).toMatchObject({ salesCents: 5000, fiadoCents: 800, totalCents: 5800 });
    expect(s.drawerTotalCents).toBe(5000 + 3000 + 2000 + 800 + 400);
    expect(s.online.totalCents).toBe(9000);
    expect(s.fiado).toMatchObject({ soldCents: 1500, receivedCents: 1200 });
    // gaveta: troco inicial + vendas em dinheiro + fiado recebido em dinheiro (venda cancelada não conta)
    expect(s.cash.expectedCents).toBe(10000 + 5000 + 800);
  });

  it('agrupa por colaborador, hora local e produto', () => {
    const s = daySummary('2026-11-14', [
      sale({ staff: { name: 'Ana' }, createdAt: at('2026-11-14T12:10:00Z'), items: [{ productName: 'Café', quantity: 2, totalCents: 1000 }] }),
      sale({ createdAt: at('2026-11-14T12:50:00Z'), items: [{ productName: 'Café', quantity: 1, totalCents: 500 }, { productName: 'Pão', quantity: 3, totalCents: 300 }] }),
    ], []);
    expect(s.byStaff.map((x) => x.name).sort()).toEqual(['Ana', 'Dono']);
    expect(s.byHour).toEqual([{ hour: 9, count: 2, totalCents: 2000 }]);
    expect(s.topProducts[0]).toEqual({ name: 'Café', quantity: 3, totalCents: 1500 });
    expect(s.sales.items).toBe(6);
  });
});
