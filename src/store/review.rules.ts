/** Regras puras das avaliações dos produtos (estrelas, comentário e até 3 fotos). */

export const MAX_REVIEW_PHOTOS = 3;
export const MAX_REVIEW_TEXT = 1000;

/** Pedidos que já podem ser avaliados: pagos (ou entregues, no pagar na entrega). */
export const REVIEWABLE = ['paid', 'preparing', 'ready_for_pickup', 'shipped', 'delivered'] as const;
export const canReview = (status: string) => (REVIEWABLE as readonly string[]).includes(status);

/** Nome mostrado na avaliação: primeiro nome e a inicial do sobrenome ("Ana S."). */
export function reviewerName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Cliente';
  const first = parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase();
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

/** Média com uma casa e quantidade, a partir das notas visíveis. */
export function summarize(ratings: number[]) {
  if (!ratings.length) return { avg: 0, count: 0 };
  return { avg: Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10, count: ratings.length };
}

/** Distribuição 5★…1★ (para as barras do resumo). */
export function distribution(ratings: number[]) {
  const d = [0, 0, 0, 0, 0];
  for (const r of ratings) if (r >= 1 && r <= 5) d[5 - r]++;
  return d;
}
