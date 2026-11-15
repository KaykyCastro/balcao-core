/**
 * Desconto fixo do produto (o do cadastro, não a promoção com período). Pode ser dado em porcentagem ou em reais;
 * o produto guarda as duas leituras: `priceWithDiscount` (o preço cobrado) e `discountPercentage` (o "−X%" da vitrine),
 * mais `discountMode` para o formulário reabrir do jeito que foi digitado. Tudo em centavos aqui, sem erro de arredondamento.
 */
export type DiscountMode = 'percent' | 'amount';
export type DiscountResult = { priceWithDiscountCents: number; percent: number } | { error: string };

export function productDiscount(priceCents: number, mode: DiscountMode, value: number): DiscountResult {
  if (!value) return { priceWithDiscountCents: 0, percent: 0 };
  if (mode === 'percent') {
    if (value < 0 || value >= 100) return { error: 'O desconto em porcentagem vai de 0 a 99,99%' };
    const p = Math.round(priceCents * (1 - value / 100));
    return p >= 1 ? { priceWithDiscountCents: p, percent: Math.round(value * 100) / 100 } : { error: 'O desconto deixaria o produto de graça' };
  }
  // value = centavos de desconto
  if (!Number.isInteger(value) || value < 0) return { error: 'Desconto em reais inválido' };
  if (value >= priceCents) return { error: 'O desconto em reais precisa ser menor que o preço' };
  return { priceWithDiscountCents: priceCents - value, percent: Math.round((value * 10000) / priceCents) / 100 };
}

/** Preço com desconto já pronto (reais) → conferência e o percentual que acompanha. */
export function fromFinalPrice(priceCents: number, finalCents: number): DiscountResult {
  if (!finalCents) return { priceWithDiscountCents: 0, percent: 0 };
  if (finalCents >= priceCents) return { error: 'O preço com desconto precisa ser menor que o preço' };
  return productDiscount(priceCents, 'amount', priceCents - finalCents);
}
