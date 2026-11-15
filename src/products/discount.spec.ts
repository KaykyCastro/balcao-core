import { fromFinalPrice, productDiscount } from './discount.rules';

describe('Desconto do produto (% ou R$)', () => {
  it('em porcentagem calcula o preço cobrado', () => {
    expect(productDiscount(25990, 'percent', 10)).toEqual({ priceWithDiscountCents: 23391, percent: 10 });
  });
  it('em reais tira o valor e calcula o percentual da vitrine', () => {
    expect(productDiscount(25990, 'amount', 2600)).toEqual({ priceWithDiscountCents: 23390, percent: 10 });
    expect(productDiscount(4990, 'amount', 1000)).toEqual({ priceWithDiscountCents: 3990, percent: 20.04 });
  });
  it('zero = sem desconto', () => {
    expect(productDiscount(1000, 'amount', 0)).toEqual({ priceWithDiscountCents: 0, percent: 0 });
    expect(productDiscount(1000, 'percent', 0)).toEqual({ priceWithDiscountCents: 0, percent: 0 });
  });
  it('não deixa o produto de graça nem com desconto maior que o preço', () => {
    expect(productDiscount(1000, 'amount', 1000)).toHaveProperty('error');
    expect(productDiscount(1000, 'amount', 1500)).toHaveProperty('error');
    expect(productDiscount(1000, 'percent', 100)).toHaveProperty('error');
    expect(productDiscount(1, 'percent', 60)).toHaveProperty('error');
  });
  it('preço final pronto: confere e devolve o percentual', () => {
    expect(fromFinalPrice(25990, 23390)).toEqual({ priceWithDiscountCents: 23390, percent: 10 });
    expect(fromFinalPrice(25990, 25990)).toHaveProperty('error');
  });
});
