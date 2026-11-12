/** Utilitários de dinheiro. Valores internos novos sempre em centavos inteiros. */
export const toCents = (reais: number): number => Math.round(reais * 100);
export const fromCents = (cents: number): number => cents / 100;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Maior valor recebido em dinheiro (e desconto em reais) aceito numa venda, comanda ou pedido: R$ 100 milhões. */
export const CASH_MAX_CENTS = 10_000_000_000;
