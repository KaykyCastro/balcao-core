import { allocateCredit, cashbackCents, couponDiscountCents, couponLabel, couponProblem, creditToUse, normalizeCode, COUPON_CODE_RE, type CouponLike } from './rewards.rules';

const now = new Date('2026-11-05T12:00:00Z');
const base: CouponLike = { active: true, kind: 'percent', percent: 10, amountCents: null, minOrderCents: 0, maxDiscountCents: null, startsAt: null, endsAt: null, maxUses: null, used: 0 };

describe('cupons', () => {
  it('normaliza e valida o código', () => {
    expect(normalizeCode(' bem vindo10 ')).toBe('BEMVINDO10');
    expect(COUPON_CODE_RE.test('BEMVINDO10')).toBe(true);
    expect(COUPON_CODE_RE.test('A')).toBe(false);
    expect(COUPON_CODE_RE.test('<script>')).toBe(false);
  });
  it('percentual com teto e valor fixo nunca passam do subtotal', () => {
    expect(couponDiscountCents(base, 20000)).toBe(2000);
    expect(couponDiscountCents({ ...base, maxDiscountCents: 1500 }, 20000)).toBe(1500);
    expect(couponDiscountCents({ ...base, kind: 'amount', amountCents: 5000 }, 3000)).toBe(3000);
  });
  it('recusa com o motivo certo', () => {
    expect(couponProblem({ ...base, active: false }, 10000, now)).toMatch(/desativado/);
    expect(couponProblem({ ...base, endsAt: new Date('2026-11-01') }, 10000, now)).toMatch(/expirou/);
    expect(couponProblem({ ...base, startsAt: new Date('2026-12-01') }, 10000, now)).toMatch(/ainda não/);
    expect(couponProblem({ ...base, maxUses: 5, used: 5 }, 10000, now)).toMatch(/todo usado/);
    expect(couponProblem({ ...base, minOrderCents: 15000 }, 10000, now)).toMatch(/a partir de R\$\s?150,00/);
    expect(couponProblem(base, 10000, now, 1, true)).toMatch(/já usou/);
    expect(couponProblem(base, 10000, now)).toBeNull();
  });
  it('rótulo curto', () => {
    expect(couponLabel(base)).toBe('10% OFF');
    expect(couponLabel({ ...base, kind: 'amount', amountCents: 2000 })).toMatch(/R\$\s?20 OFF/);
  });
});

describe('cashback', () => {
  it('calcula sobre o que foi pago pelos produtos', () => {
    expect(cashbackCents(10000, 500)).toBe(500); // 5%
    expect(cashbackCents(999, 300)).toBe(29);
    expect(cashbackCents(10000, 0)).toBe(0);
  });
  it('usa no máximo o valor dos produtos', () => {
    expect(creditToUse(5000, 3000)).toBe(3000);
    expect(creditToUse(1000, 3000)).toBe(1000);
  });
  it('gasta primeiro o crédito que vence antes e ignora o vencido', () => {
    const lots = [
      { id: 'a', remainingCents: 500, expiresAt: new Date('2027-01-01') },
      { id: 'b', remainingCents: 300, expiresAt: new Date('2026-12-01') },
      { id: 'velho', remainingCents: 900, expiresAt: new Date('2026-10-01') },
    ];
    expect(allocateCredit(lots, 600, now)).toEqual([{ id: 'b', cents: 300 }, { id: 'a', cents: 300 }]);
    expect(allocateCredit(lots, 2000, now)).toEqual([]);
  });
});
