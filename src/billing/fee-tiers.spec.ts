import { feeForSale, monthCapCents, settleMonth, tierFor, tiersFrom } from './fee-tiers';

const cap = (base: number) => monthCapCents(base, {});
/** Simula um mês de vendas pela regra de cada venda. */
function month(sales: number[]) {
  let m = { rawCents: 0, baseCents: 0, chargedCents: 0 };
  for (const s of sales) {
    const f = feeForSale(m, s, cap);
    m = { rawCents: m.rawCents + f.rawCents, baseCents: m.baseCents + s, chargedCents: m.chargedCents + f.feeCents };
  }
  return m;
}
const many = (total: number, each = 50_000) => Array.from({ length: Math.round(total / each) }, () => each); // vendas de R$ 500

describe('taxa por faixa de faturamento (teto mensal que acompanha o mês)', () => {
  it('faixas dos Termos', () => {
    expect(tierFor(2_000_000).capCents).toBe(4_000);
    expect(tierFor(2_000_001).capCents).toBe(10_000);
    expect(tierFor(5_000_000).capCents).toBe(10_000);
    expect(tierFor(15_000_000).capCents).toBe(35_000);
    expect(tierFor(90_000_000).capCents).toBe(50_000);
  });

  it('exemplos do lojista: R$ 20 mil → R$ 40; R$ 50 mil → R$ 100; de novo R$ 20 mil → R$ 40', () => {
    expect(month(many(2_000_000)).chargedCents).toBe(4_000);
    expect(month(many(5_000_000)).chargedCents).toBe(10_000);
    expect(month(many(2_000_000)).chargedCents).toBe(4_000); // cada mês começa do zero
  });

  it('exemplos dos Termos: R$ 5 mil → R$ 25 (0,5%); R$ 15 mil → R$ 40; R$ 30 mil → R$ 100', () => {
    expect(month(many(500_000)).chargedCents).toBe(2_500);
    expect(month(many(1_500_000)).chargedCents).toBe(4_000);
    expect(month(many(3_000_000)).chargedCents).toBe(10_000);
  });

  it('a venda que cruza de faixa leva a diferença do teto', () => {
    const at20k = month(many(2_000_000));
    const f = feeForSale(at20k, 10_000, cap); // +R$ 100 → R$ 20.100, 2ª faixa
    expect(f.feeCents).toBe(10_000 - 4_000);
  });

  it('teto negociado e teto fixo (meses antes das faixas) valem no lugar das faixas', () => {
    expect(monthCapCents(9_000_000, { negotiated: 1_500 })).toBe(1_500);
    expect(monthCapCents(9_000_000, { fixed: 4_000 })).toBe(4_000);
  });

  it('fechamento: cobra a diferença ou devolve só o que ainda não foi faturado', () => {
    // Cancelou vendas depois de cruzar a faixa: cobrou 100, o mês fechou em R$ 19 mil (deve 40).
    expect(settleMonth({ rawCents: 9_500, baseCents: 1_900_000, chargedCents: 10_000, unbilledCents: 10_000 }, cap)).toEqual({ dueCents: 4_000, adjustCents: -6_000 });
    expect(settleMonth({ rawCents: 9_500, baseCents: 1_900_000, chargedCents: 10_000, unbilledCents: 2_000 }, cap).adjustCents).toBe(-2_000);
    expect(settleMonth({ rawCents: 15_000, baseCents: 3_000_000, chargedCents: 4_000, unbilledCents: 0 }, cap).adjustCents).toBe(6_000);
    expect(settleMonth({ rawCents: 4_000, baseCents: 800_000, chargedCents: 4_000, unbilledCents: 4_000 }, cap).adjustCents).toBe(0);
  });

  it('mês inicial das faixas', () => {
    expect(tiersFrom(undefined)).toBe('2026-12');
    expect(tiersFrom('2027-01')).toBe('2027-01');
    expect(tiersFrom('lixo')).toBe('2026-12');
  });
});
