/**
 * Filiais. Uma empresa (a matriz) pode ter filiais; cada filial é uma empresa própria no Balcão (produtos, estoque,
 * vendas, clientes, caixa, colaboradores, loja online e fatura separados), isolada pela mesma trava das lojas
 * (tenant guard). A filial não tem login próprio: o dono da matriz entra nela pela troca de loja.
 */
export const MAX_BRANCHES = 30;

/** E-mail interno da filial: o campo é obrigatório e único, mas nunca recebe nada (a cobrança usa o da matriz). */
export const BRANCH_EMAIL_DOMAIN = 'filiais.usebalcao.invalid';
export const branchEmail = (id: string) => `filial-${id}@${BRANCH_EMAIL_DOMAIN}`;
export const isBranchEmail = (email: string | null | undefined) => !!email && email.toLowerCase().endsWith(`@${BRANCH_EMAIL_DOMAIN}`);

export class BranchError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 403 | 404 | 409 = 409) { super(message); }
}

export function branchName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) throw new BranchError('BRANCH_NAME', 'Dê um nome de 2 a 60 letras para a filial (ex.: Loja Centro).', 400);
  return name;
}

/** Matriz do grupo de uma empresa (ela mesma, se não for filial). */
export const rootOf = (e: { _id: unknown; parentId?: unknown }) => String(e.parentId ?? e._id);

export interface ImportSource {
  _id: unknown; code: string; name: string; categoryName: string;
}

/**
 * O que importar: pula produtos cujo código já existe na loja de destino (o código é único por loja) e diz quais
 * categorias precisam ser criadas (casadas pelo nome, sem diferença de maiúsculas).
 */
export function importPlan(source: ImportSource[], existingCodes: Iterable<string>, existingCategories: Iterable<string>) {
  const codes = new Set([...existingCodes].map((c) => c.trim().toLowerCase()));
  const cats = new Set([...existingCategories].map((c) => c.trim().toLowerCase()));
  const take: ImportSource[] = [];
  const skipped: { code: string; name: string }[] = [];
  const newCategories: string[] = [];
  for (const p of source) {
    const key = p.code.trim().toLowerCase();
    if (codes.has(key)) { skipped.push({ code: p.code, name: p.name }); continue; }
    codes.add(key); // dois produtos com o mesmo código na origem não entram duas vezes
    take.push(p);
    const cat = p.categoryName.trim();
    if (cat && !cats.has(cat.toLowerCase())) { cats.add(cat.toLowerCase()); newCategories.push(cat); }
  }
  return { take, skipped, newCategories };
}

/** Uma filial nova não ganha outro período grátis: herda o fim do teste da matriz (ou começa já sem teste). */
export function branchTrialEnd(rootTrialEnd: Date | null | undefined, now = new Date()): Date {
  return rootTrialEnd && rootTrialEnd > now ? rootTrialEnd : now;
}
