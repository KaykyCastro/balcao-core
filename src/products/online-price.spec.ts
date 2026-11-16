import { onlineEffectivePrice, onlineFullPrice } from './schema/product.schema';

describe('preço na loja online com desconto', () => {
  it('sem preço online próprio, usa o do balcão com desconto', () => {
    expect(onlineEffectivePrice({ price: 100, priceWithDiscount: 90, discountMode: 'percent', discountPercentage: 10 })).toBe(90);
    expect(onlineEffectivePrice({ price: 100, priceWithDiscount: 0 })).toBe(100);
  });

  it('com preço online próprio, aplica a mesma % de desconto', () => {
    const p = { price: 100, priceWithDiscount: 90, onlinePrice: 105.27, discountMode: 'percent' as const, discountPercentage: 10 };
    expect(onlineEffectivePrice(p)).toBe(94.74);
    expect(onlineFullPrice(p)).toBe(105.27);
  });

  it('com desconto em reais, tira os mesmos reais do preço online', () => {
    expect(onlineEffectivePrice({ price: 100, priceWithDiscount: 85, onlinePrice: 110, discountMode: 'amount', discountPercentage: 15 })).toBe(95);
  });

  it('sem desconto, o preço online fica como está e nunca vai a zero', () => {
    expect(onlineEffectivePrice({ price: 100, priceWithDiscount: 0, onlinePrice: 110 })).toBe(110);
    expect(onlineEffectivePrice({ price: 100, priceWithDiscount: 1, onlinePrice: 50, discountMode: 'amount' })).toBe(0.01);
  });
});
