/** Regras puras das promoções (testadas em promotion.spec.ts). */
export type PromotionStatus = 'scheduled' | 'active' | 'sold_out' | 'expired' | 'ended';

export interface PromoLike { startsAt: Date; endsAt: Date | null; endedAt: Date | null; limitUnits: number | null; soldUnits: number }

export function promotionStatus(p: PromoLike, now = new Date()): PromotionStatus {
  if (p.endedAt) return 'ended';
  if (p.limitUnits != null && p.soldUnits >= p.limitUnits) return 'sold_out';
  if (p.endsAt && p.endsAt <= now) return 'expired';
  if (p.startsAt > now) return 'scheduled';
  return 'active';
}

/** Unidades que ainda podem sair pelo preço promocional (null = sem limite). */
export const remainingUnits = (p: Pick<PromoLike, 'limitUnits' | 'soldUnits'>): number | null =>
  p.limitUnits == null ? null : Math.max(0, p.limitUnits - p.soldUnits);

/** Quantas das `wanted` unidades levam o preço promocional. */
export const promoUnits = (p: Pick<PromoLike, 'limitUnits' | 'soldUnits'>, wanted: number): number => {
  const r = remainingUnits(p);
  return r == null ? wanted : Math.min(wanted, r);
};

/** Preço promocional a partir do preço cheio e do percentual (arredonda para o centavo). */
export const percentPrice = (regularCents: number, percent: number) => Math.round(regularCents * (1 - percent / 100));
