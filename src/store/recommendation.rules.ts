/**
 * Regras puras da recomendação do marketplace "Lojas no Balcão" (sem banco: fácil de testar).
 *
 * Só existe com o aceite de "Preferências" nos cookies (sem ele não há visitante nem histórico). A partir do que a
 * pessoa VIU, CURTIU e PÔS NO CARRINHO (o peso cai pela metade a cada 7 dias), o perfil aprende:
 *  - categorias, lojas e ramos (moda, beleza…) de que ela mais gosta;
 *  - a faixa de preço que ela costuma olhar (média e espalhamento, em escala logarítmica);
 *  - as palavras dos produtos que interessaram ("vestido", "tênis"), para achar parecidos em outras lojas;
 * e o serviço junta o "quem se interessou pelos mesmos produtos também viu" (colaborativo). A nota de cada produto
 * mistura tudo isso com um pouco de popularidade e de novidade; a lista final varia lojas e categorias.
 */

export const VISITOR_RE = /^[a-f0-9]{32}$/;
/** Pôr no carrinho pesa mais que curtir, que pesa mais que ver. */
export const WEIGHT = { view: 1, like: 4, cart: 6 } as const;
export type EventKind = keyof typeof WEIGHT;
export const HALF_LIFE_DAYS = 7;

export interface Interaction {
  productId: string; enterpriseId: string; categoryId: string | null; kind: EventKind; at: Date;
  /** Do produto (quando ainda existe): ramo da loja, preço em centavos e nome. */
  segment?: string | null; priceCents?: number | null; name?: string | null;
}

const decay = (at: Date, now: Date) => 0.5 ** (Math.max(0, now.getTime() - at.getTime()) / (HALF_LIFE_DAYS * 864e5));

const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'sem', 'para', 'por', 'e', 'em', 'na', 'no', 'kit', 'cor', 'tam', 'tamanho', 'un', 'und', 'unidade', 'unidades', 'ml', 'g', 'kg', 'cm', 'mm', 'novo', 'nova', 'original', 'premium', 'promo', 'promocao', 'oferta']);
/** Palavras que identificam o produto: minúsculas, sem acento, 3+ letras, sem as genéricas. */
export function tokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const words = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/);
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

export interface Profile {
  categories: Map<string, number>; stores: Map<string, number>; segments: Map<string, number>; words: Map<string, number>;
  /** Faixa de preço (log dos centavos): média e espalhamento. null = sem preço no histórico. */
  price: { mu: number; sigma: number } | null;
  /** Já vistos/curtidos/no carrinho (a recomendação mostra coisa nova). */
  seen: Set<string>;
  /** Peso total do histórico (0 = sem histórico). */
  strength: number;
}

/** Perfil de interesse do visitante, a partir do histórico (com o peso caindo com o tempo). */
export function interestProfile(events: Interaction[], now = new Date()): Profile {
  const p: Profile = { categories: new Map(), stores: new Map(), segments: new Map(), words: new Map(), price: null, seen: new Set(), strength: 0 };
  const add = (m: Map<string, number>, k: string | null | undefined, w: number) => { if (k) m.set(k, (m.get(k) ?? 0) + w); };
  let sw = 0, sx = 0, sxx = 0;
  for (const e of events) {
    const w = WEIGHT[e.kind] * decay(e.at, now);
    p.strength += w;
    add(p.categories, e.categoryId, w); add(p.stores, e.enterpriseId, w); add(p.segments, e.segment, w);
    for (const t of tokens(e.name)) add(p.words, t, w);
    if (e.priceCents && e.priceCents > 0) { const x = Math.log(e.priceCents); sw += w; sx += w * x; sxx += w * x * x; }
    p.seen.add(e.productId);
  }
  if (sw > 0) {
    const mu = sx / sw;
    // Espalhamento mínimo de ~40% no preço: uma pessoa que viu um item só não fica presa a um preço exato.
    p.price = { mu, sigma: Math.max(0.35, Math.sqrt(Math.max(0, sxx / sw - mu * mu))) };
  }
  return p;
}

export interface Candidate {
  id: string; enterpriseId: string; categoryId: string | null; popularity: number; createdAt?: Date | null;
  segment?: string | null; priceCents?: number | null; name?: string | null;
}

/** Pesos da nota (somam 1). Categoria e palavras dizem "o quê"; preço diz "quanto"; colaborativo, "quem é parecido". */
export const SCORE = { category: 0.26, words: 0.16, collab: 0.16, price: 0.12, segment: 0.1, store: 0.1, popularity: 0.06, fresh: 0.04 } as const;

const norm = (m: Map<string, number>) => { const max = Math.max(0, ...m.values()); return (k: string | null | undefined) => (k && max > 0 ? (m.get(k) ?? 0) / max : 0); };

/**
 * Nota de 0 a 1 de cada candidato para este perfil. `collab` = nota colaborativa por produto (0 a 1, do serviço).
 * Sem histórico, a nota é só popularidade e novidade (o que está em alta).
 */
export function scorer(profile: Profile, opts: { collab?: Map<string, number>; maxPopularity?: number; now?: Date } = {}) {
  const cat = norm(profile.categories), st = norm(profile.stores), seg = norm(profile.segments), wd = norm(profile.words);
  const collab = opts.collab ?? new Map<string, number>();
  const maxP = Math.max(1, opts.maxPopularity ?? 1);
  const now = (opts.now ?? new Date()).getTime();
  const personal = profile.strength > 0;
  return (c: Candidate) => {
    const pop = Math.min(1, c.popularity / maxP);
    // Novo: 1 hoje, 0,5 com 30 dias.
    const fresh = c.createdAt ? 0.5 ** ((now - new Date(c.createdAt).getTime()) / (30 * 864e5)) : 0;
    if (!personal) return pop * 0.85 + fresh * 0.15;
    const words = tokens(c.name);
    const wordScore = words.length ? Math.min(1, words.reduce((n, t) => n + wd(t), 0) / Math.min(2, words.length)) : 0;
    const price = profile.price && c.priceCents && c.priceCents > 0 ? Math.exp(-((Math.log(c.priceCents) - profile.price.mu) ** 2) / (2 * profile.price.sigma ** 2)) : 0.5;
    return SCORE.category * cat(c.categoryId) + SCORE.words * wordScore + SCORE.collab * (collab.get(c.id) ?? 0) + SCORE.price * price
      + SCORE.segment * seg(c.segment) + SCORE.store * st(c.enterpriseId) + SCORE.popularity * pop + SCORE.fresh * fresh;
  };
}

/**
 * Ordena candidatos pela nota, variando: no máximo `perStore` por loja e `perCategory` por categoria na primeira
 * passada (o que sobra vem depois, para marketplace com poucas lojas). O que combina MUITO com a pessoa (nota ≥ 70% da
 * melhor) não é segurado pela variedade: gosto claro vem antes de variar.
 * `excludeSeen`: tira o que a pessoa já viu (faixa "Escolhidos para você"); sem ele, o já visto só vai para o fim
 * (vitrine completa "para você"). `minShare`: com histórico, descarta o que tem nota abaixo dessa fração da melhor
 * (mantendo pelo menos `keep`), para a faixa mostrar só o que interessa e não completar com qualquer coisa.
 */
export function rankCandidates(cands: Candidate[], profile: Profile, opts: { limit?: number; collab?: Map<string, number>; excludeSeen?: boolean; perStore?: number; perCategory?: number; minShare?: number; keep?: number; now?: Date } = {}): string[] {
  const { limit = 12, excludeSeen = true, perStore = 3, perCategory = 4, minShare = 0, keep = 4 } = opts;
  const score = scorer(profile, { collab: opts.collab, maxPopularity: Math.max(1, ...cands.map((c) => c.popularity)), now: opts.now });
  const pool = excludeSeen ? cands.filter((c) => !profile.seen.has(c.id)) : cands;
  let scored = pool.map((c) => ({ c, s: score(c) - (profile.seen.has(c.id) ? 1 : 0) })).sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
  const best = scored[0]?.s ?? 0;
  const personal = profile.strength > 0;
  if (personal && minShare > 0 && best > 0) scored = scored.filter((x, i) => i < keep || x.s >= best * minShare);
  const strong = personal && best > 0 ? best * 0.7 : Infinity;
  const byStore = new Map<string, number>(), byCat = new Map<string, number>(), out: string[] = [], rest: string[] = [];
  for (const { c, s } of scored) {
    const cat = c.categoryId ?? '-';
    if (s < strong && ((byStore.get(c.enterpriseId) ?? 0) >= perStore || (byCat.get(cat) ?? 0) >= perCategory)) { rest.push(c.id); continue; }
    byStore.set(c.enterpriseId, (byStore.get(c.enterpriseId) ?? 0) + 1);
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
    out.push(c.id);
    // A variedade vale para cada "página" de 12: depois disso, os limites recomeçam.
    if (out.length % 12 === 0) { byStore.clear(); byCat.clear(); }
  }
  return [...out, ...rest].slice(0, limit);
}

/**
 * Colaborativo ("quem se interessou pelos mesmos produtos também viu"): dado o histórico de outras pessoas que
 * tocaram nos mesmos produtos, soma o interesse delas nos OUTROS produtos (pesado pelo quanto cada uma se parece com
 * esta pessoa) e devolve uma nota de 0 a 1 por produto.
 */
export function collaborative(mine: Set<string>, others: { visitorId: string; productId: string; kind: EventKind }[], minPeers = 2): Map<string, number> {
  const byVisitor = new Map<string, { productId: string; kind: EventKind }[]>();
  for (const e of others) { const l = byVisitor.get(e.visitorId) ?? []; l.push(e); byVisitor.set(e.visitorId, l); }
  const out = new Map<string, number>(), peers = new Map<string, Set<string>>();
  for (const [vid, evs] of byVisitor) {
    const theirs = new Set(evs.map((e) => e.productId));
    const overlap = [...theirs].filter((x) => mine.has(x)).length;
    if (!overlap) continue;
    const sim = overlap / Math.sqrt(theirs.size * Math.max(1, mine.size)); // parecido com o cosseno
    for (const e of evs) if (!mine.has(e.productId)) {
      out.set(e.productId, (out.get(e.productId) ?? 0) + sim * WEIGHT[e.kind]);
      peers.set(e.productId, (peers.get(e.productId) ?? new Set()).add(vid));
    }
  }
  // Uma pessoa só não é padrão: precisa de pelo menos `minPeers` pessoas parecidas apontando o mesmo produto.
  for (const k of [...out.keys()]) if ((peers.get(k)?.size ?? 0) < minPeers) out.delete(k);
  const max = Math.max(0, ...out.values());
  if (max > 0) for (const [k, v] of out) out.set(k, v / max);
  return out;
}

/** O que a página pode usar para reordenar faixas e o menu: as preferências mais fortes (só ids e chaves). */
export function profileSummary(p: Profile) {
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return { categories: top(p.categories, 6), stores: top(p.stores, 4), segments: top(p.segments, 4), price: p.price ? { minCents: Math.round(Math.exp(p.price.mu - p.price.sigma)), maxCents: Math.round(Math.exp(p.price.mu + p.price.sigma)) } : null };
}
