/**
 * Regras puras de cupons e cashback da loja online (sem banco: fáceis de testar).
 * Desconto do cupom e uso do crédito valem só sobre os produtos (o frete é cobrado à parte).
 */

export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
export const normalizeCode = (c: string) => c.trim().toUpperCase().replace(/\s+/g, '');

export interface CouponLike {
  active: boolean; kind: 'percent' | 'amount'; percent?: number | null; amountCents?: number | null;
  minOrderCents: number; maxDiscountCents?: number | null; startsAt?: Date | null; endsAt?: Date | null;
  maxUses?: number | null; used: number;
}

/** Por que o cupom não vale (null = vale). `perCustomerUsed` = vezes que este cliente já usou (cupom de uso único). */
export function couponProblem(c: CouponLike, subtotalCents: number, now = new Date(), perCustomerUsed = 0, onePerCustomer = false): string | null {
  if (!c.active) return 'Este cupom está desativado';
  if (c.startsAt && c.startsAt > now) return 'Este cupom ainda não começou a valer';
  if (c.endsAt && c.endsAt <= now) return 'Este cupom expirou';
  if (c.maxUses != null && c.used >= c.maxUses) return 'Este cupom já foi todo usado';
  if (onePerCustomer && perCustomerUsed > 0) return 'Você já usou este cupom';
  if (subtotalCents < c.minOrderCents) return `Este cupom vale para compras a partir de ${(c.minOrderCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
  return null;
}

/** Valor do desconto em centavos (nunca maior que o subtotal dos produtos). */
export function couponDiscountCents(c: Pick<CouponLike, 'kind' | 'percent' | 'amountCents' | 'maxDiscountCents'>, subtotalCents: number): number {
  let d = c.kind === 'percent' ? Math.floor((subtotalCents * (c.percent ?? 0)) / 100) : (c.amountCents ?? 0);
  if (c.kind === 'percent' && c.maxDiscountCents) d = Math.min(d, c.maxDiscountCents);
  return Math.max(0, Math.min(d, subtotalCents));
}

/** Cashback que volta como crédito: porcentagem (em pontos-base) sobre o que o cliente pagou pelos produtos. */
export const cashbackCents = (paidGoodsCents: number, rateBps: number) => Math.max(0, Math.floor((paidGoodsCents * rateBps) / 10_000));

/** Quanto do crédito usar: o saldo, até o valor dos produtos depois do cupom. */
export const creditToUse = (balanceCents: number, payableGoodsCents: number) => Math.max(0, Math.min(balanceCents, payableGoodsCents));

export interface EarnLot { id: string; remainingCents: number; expiresAt: Date }
/** De onde sai o crédito usado: primeiro o que vence antes (assim o cliente perde menos por validade). */
export function allocateCredit(lots: EarnLot[], amountCents: number, now = new Date()): { id: string; cents: number }[] {
  const out: { id: string; cents: number }[] = [];
  let left = amountCents;
  for (const l of [...lots].filter((x) => x.remainingCents > 0 && x.expiresAt > now).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())) {
    if (left <= 0) break;
    const take = Math.min(l.remainingCents, left);
    out.push({ id: l.id, cents: take });
    left -= take;
  }
  return left > 0 ? [] : out; // sem saldo suficiente: não usa nada (quem chama confere antes)
}

/** Texto curto do cupom ("10% OFF", "R$ 20 OFF"). */
export function couponLabel(c: Pick<CouponLike, 'kind' | 'percent' | 'amountCents'>) {
  return c.kind === 'percent' ? `${c.percent}% OFF` : `${((c.amountCents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: (c.amountCents ?? 0) % 100 ? 2 : 0 })} OFF`;
}
