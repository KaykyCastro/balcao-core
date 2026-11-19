import { buildLedger, dueOf, itemsText, type LedgerEvent } from './customer-statement.rules';

const d = (s: string) => new Date(s);
const ev = (at: string, kind: LedgerEvent['kind'], amountCents: number, ref = 'x'): LedgerEvent => ({ at: d(at), kind, amountCents, ref, detail: '' });

describe('extrato do cliente (conta do pagamento posterior)', () => {
  const events = [
    ev('2026-10-05T15:00:00Z', 'sale', 10_000, 's1'),
    ev('2026-10-20T15:00:00Z', 'payment', -4_000, 'p1'),
    ev('2026-11-02T15:00:00Z', 'sale', 6_000, 's2'),
    ev('2026-11-03T15:00:00Z', 'cancel', -6_000, 's2'),
    ev('2026-11-10T15:00:00Z', 'payment', -2_000, 'p2'),
  ];

  it('saldo corrido, terminando na dívida real', () => {
    const r = buildLedger(events, 4_000);
    expect(r.lines.map((l) => l.balanceCents)).toEqual([10_000, 6_000, 12_000, 6_000, 4_000]);
    expect(r).toMatchObject({ openingCents: 0, closingCents: 4_000, totals: { boughtCents: 16_000, paidCents: 6_000, cancelledCents: 6_000, openingAdjustCents: 0 } });
  });

  it('dívida que não veio de vendas daqui (sistema anterior): linha de saldo anterior no começo', () => {
    const r = buildLedger(events, 9_000);
    expect(r.lines[0]).toMatchObject({ kind: 'opening', debitCents: 5_000, balanceCents: 5_000 });
    expect(r.closingCents).toBe(9_000);
    expect(r.totals.openingAdjustCents).toBe(5_000);
  });

  it('período: saldo no começo do período e só as linhas dele', () => {
    const r = buildLedger(events, 4_000, { from: d('2026-11-01T03:00:00Z'), to: d('2026-12-01T03:00:00Z') });
    expect(r.openingCents).toBe(6_000);
    expect(r.lines).toHaveLength(3);
    expect(r).toMatchObject({ closingCents: 4_000, totals: { boughtCents: 6_000, paidCents: 2_000, cancelledCents: 6_000 } });
  });

  it('período sem movimento: abre e fecha com o mesmo saldo', () => {
    const r = buildLedger(events, 4_000, { from: d('2026-09-01T03:00:00Z'), to: d('2026-10-01T03:00:00Z') });
    expect(r).toMatchObject({ openingCents: 0, closingCents: 0, lines: [] });
  });

  it('no mesmo instante, compra vem antes do pagamento', () => {
    const r = buildLedger([ev('2026-11-01T10:00:00Z', 'payment', -1_000), ev('2026-11-01T10:00:00Z', 'sale', 1_000)], 0);
    expect(r.lines.map((l) => l.kind)).toEqual(['sale', 'payment']);
  });

  it('auxiliares', () => {
    expect(dueOf({ totalCents: 10_000, creditCents: 3_000, exchangeCents: 2_000 })).toBe(5_000);
    expect(itemsText([{ productName: 'A', quantity: 2 }, { productName: 'B', quantity: 1 }, { productName: 'C', quantity: 1 }, { productName: 'D', quantity: 1 }])).toBe('2× A, 1× B, 1× C e mais 1');
  });
});
