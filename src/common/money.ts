/** Utilitários de dinheiro. Valores internos novos sempre em centavos inteiros. */
export const toCents = (reais: number): number => Math.round(reais * 100);
export const fromCents = (cents: number): number => cents / 100;
export const round2 = (n: number): number => Math.round(n * 100) / 100;
