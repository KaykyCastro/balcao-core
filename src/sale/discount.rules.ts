import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Desconto no carrinho (venda no balcão). Regras puras: o valor é sempre decidido aqui, no servidor.
 * - `percent`: `value` em pontos-base (1000 = 10%), de 1 a 10000.
 * - `amount`: `value` em centavos.
 * A venda nunca fica zerada: sobra pelo menos R$ 0,01.
 */
export type SaleDiscountInput = { mode: 'percent' | 'amount'; value: number; reason?: string };

/** Padrão para colaboradores quando o dono não escolheu: até 10%. */
export const DEFAULT_STAFF_MAX_DISCOUNT_BPS = 1000;

export function discountCents(subtotalCents: number, d: SaleDiscountInput | undefined | null): number {
  if (!d || !(d.value > 0)) return 0;
  const raw = d.mode === 'percent' ? Math.round((subtotalCents * Math.min(d.value, 10_000)) / 10_000) : Math.round(d.value);
  return Math.max(0, raw);
}

/** Valida o desconto e devolve quanto sai, em centavos. Colaborador tem teto em % (o dono não tem). */
export function applySaleDiscount(subtotalCents: number, d: SaleDiscountInput | undefined | null, staffMaxBps: number | null): number {
  const off = discountCents(subtotalCents, d);
  if (off === 0) return 0;
  if (off >= subtotalCents) throw new BadRequestException({ message: 'O desconto não pode zerar a venda', code: 'DISCOUNT_TOO_HIGH' });
  if (staffMaxBps !== null) {
    if (staffMaxBps <= 0) throw new ForbiddenException({ message: 'Seu acesso não permite dar desconto. Peça ao responsável.', code: 'DISCOUNT_NOT_ALLOWED' });
    if (off * 10_000 > subtotalCents * staffMaxBps) {
      throw new ForbiddenException({ message: `Desconto acima do permitido para colaboradores (até ${(staffMaxBps / 100).toLocaleString('pt-BR')}%)`, code: 'DISCOUNT_ABOVE_LIMIT' });
    }
  }
  return off;
}
