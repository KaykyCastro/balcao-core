import { applySaleDiscount, discountCents } from './discount.rules';

describe('desconto no carrinho', () => {
  it('calcula porcentagem em pontos-base e valor em centavos', () => {
    expect(discountCents(10_000, { mode: 'percent', value: 1000 })).toBe(1000);
    expect(discountCents(999, { mode: 'percent', value: 500 })).toBe(50); // 49,95 arredonda
    expect(discountCents(10_000, { mode: 'amount', value: 250 })).toBe(250);
    expect(discountCents(10_000, undefined)).toBe(0);
  });
  it('não deixa zerar a venda', () => {
    expect(() => applySaleDiscount(1000, { mode: 'amount', value: 1000 }, null)).toThrow('zerar');
    expect(() => applySaleDiscount(1000, { mode: 'percent', value: 10_000 }, null)).toThrow('zerar');
    expect(applySaleDiscount(1000, { mode: 'amount', value: 999 }, null)).toBe(999);
  });
  it('colaborador respeita o teto do dono', () => {
    expect(applySaleDiscount(10_000, { mode: 'percent', value: 1000 }, 1000)).toBe(1000);
    expect(() => applySaleDiscount(10_000, { mode: 'amount', value: 1001 }, 1000)).toThrow('acima do permitido');
    expect(() => applySaleDiscount(10_000, { mode: 'percent', value: 100 }, 0)).toThrow('não permite');
    expect(applySaleDiscount(10_000, undefined, 0)).toBe(0); // sem desconto, tudo certo
  });
});
