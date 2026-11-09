/** Regras puras da recomendação do marketplace (sem banco: fácil de testar). */

export const VISITOR_RE = /^[a-f0-9]{32}$/;
/** Curtir pesa mais que ver; uma interação de 7 dias atrás vale metade de uma de agora. */
export const WEIGHT = { view: 1, like: 4 } as const;
export const HALF_LIFE_DAYS = 7;

export interface Interaction { productId: string; enterpriseId: string; categoryId: string | null; kind: 'view' | 'like'; at: Date }

const decay = (at: Date, now: Date) => 0.5 ** ((now.getTime() - at.getTime()) / (HALF_LIFE_DAYS * 864e5));

/** Interesse do visitante por categoria e por loja, a partir do histórico (com o peso caindo com o tempo). */
export function interestProfile(events: Interaction[], now = new Date()) {
  const cats = new Map<string, number>(), stores = new Map<string, number>(), seen = new Set<string>();
  for (const e of events) {
    const w = WEIGHT[e.kind] * decay(e.at, now);
    if (e.categoryId) cats.set(e.categoryId, (cats.get(e.categoryId) ?? 0) + w);
    stores.set(e.enterpriseId, (stores.get(e.enterpriseId) ?? 0) + w);
    seen.add(e.productId);
  }
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return { categories: top(cats, 4), stores: top(stores, 3), seen };
}

export interface Candidate { id: string; enterpriseId: string; categoryId: string | null; popularity: number; createdAt?: Date | null }

/**
 * Ordena candidatos: afinidade com as categorias e lojas preferidas + um pouco de popularidade.
 * Produtos já vistos ou curtidos saem (a ideia é mostrar coisa nova). Primeiro no máximo 3 por loja, para variar;
 * se faltar, completa com o que sobrou (marketplace com poucas lojas).
 */
export function rankCandidates(cands: Candidate[], profile: ReturnType<typeof interestProfile>, limit = 12): string[] {
  const cat = new Map(profile.categories), st = new Map(profile.stores);
  const maxC = Math.max(1, ...cat.values()), maxS = Math.max(1, ...st.values()), maxP = Math.max(1, ...cands.map((c) => c.popularity));
  const scored = cands.filter((c) => !profile.seen.has(c.id)).map((c) => ({
    id: c.id, store: c.enterpriseId,
    score: ((c.categoryId && cat.get(c.categoryId)) || 0) / maxC * 0.6 + (st.get(c.enterpriseId) ?? 0) / maxS * 0.25 + c.popularity / maxP * 0.15,
  })).sort((a, b) => b.score - a.score);
  const perStore = new Map<string, number>(), out: string[] = [], rest: string[] = [];
  for (const s of scored) {
    if ((perStore.get(s.store) ?? 0) >= 3) { rest.push(s.id); continue; }
    perStore.set(s.store, (perStore.get(s.store) ?? 0) + 1);
    out.push(s.id);
  }
  return [...out, ...rest].slice(0, limit);
}
