/**
 * Conexão do Mercado Pago "por credencial" (modo token): o lojista cola as credenciais de PRODUÇÃO da aplicação que ele
 * mesmo criou no painel de desenvolvedores do Mercado Pago. Serve enquanto o OAuth do Balcão não é liberado.
 * Regras puras (sem banco e sem rede); spec em mp-token.spec.ts.
 *
 * O que muda em relação ao OAuth:
 * - Não há refresh: o token vale até o lojista trocar ou revogar. Um 401 do Mercado Pago marca a conexão como inválida
 *   (os dados ficam; o lojista cola um token novo).
 * - Sem marketplace_fee (só funciona com OAuth): a taxa da loja online vai para a fatura mensal do Balcão, com o mesmo
 *   estorno de qualquer taxa não faturada quando o pedido é cancelado ou devolvido.
 * - Os avisos do Mercado Pago vão para a aplicação DO LOJISTA (não temos o segredo dela, então não dá para conferir
 *   x-signature). Nunca se confia no corpo do aviso: o pagamento é sempre consultado na API com o token do lojista.
 *   A API de Orders não aceita notification_url por cobrança, então o lojista cadastra no painel dele o endereço
 *   assinado da loja (webhookUrlFor) e, por garantia, o Balcão consulta as cobranças pendentes sozinho (pollPlan).
 */
export type MpMode = 'oauth' | 'token';
export type FeeCollection = 'split' | 'invoice';

/**
 * Access Token de produção: APP_USR-<app>-<data>-<hash>-<user_id> (formato de hoje). O formato é conferido de leve,
 * para não recusar um token válido se o Mercado Pago mudar o desenho; quem decide é a consulta a /users/me.
 */
const ACCESS_RE = /^APP_USR-[A-Za-z0-9-]{20,200}$/;
/** Public Key de produção: APP_USR-<uuid>. */
const PUBLIC_RE = /^APP_USR-[A-Za-z0-9-]{20,120}$/;
/** O último bloco do token costuma ser o user_id da conta: serve para conferir com /users/me. */
const userIdOf = (token: string) => /-(\d{3,20})$/.exec(token)?.[1] ?? '';

export type TokenInputCheck =
  /** `userIdHint`: user_id lido do fim do token ('' se não der); tem de bater com /users/me. */
  | { ok: true; accessToken: string; publicKey: string; userIdHint: string }
  | { ok: false; code: 'MP_TEST_CREDENTIALS' | 'MP_TOKEN_FORMAT' | 'MP_PUBLIC_KEY_FORMAT'; message: string };

/** Confere o formato do que foi colado (antes de chamar o Mercado Pago). Espaços e quebras de linha são ignorados. */
export function checkTokenInput(raw: { accessToken?: unknown; publicKey?: unknown }): TokenInputCheck {
  const accessToken = String(raw.accessToken ?? '').replace(/\s+/g, '');
  const publicKey = String(raw.publicKey ?? '').replace(/\s+/g, '');
  if (/^TEST-/i.test(accessToken) || /^TEST-/i.test(publicKey)) {
    return { ok: false, code: 'MP_TEST_CREDENTIALS', message: 'Essas são credenciais de TESTE (começam com TEST-). Elas não recebem dinheiro de verdade. No painel do Mercado Pago, abra a sua aplicação, vá em "Credenciais de produção" e copie as chaves que começam com APP_USR-.' };
  }
  if (!ACCESS_RE.test(accessToken)) return { ok: false, code: 'MP_TOKEN_FORMAT', message: 'Esse não parece um Access Token de produção. Ele começa com APP_USR- e fica em "Credenciais de produção" da sua aplicação no Mercado Pago.' };
  if (!PUBLIC_RE.test(publicKey)) return { ok: false, code: 'MP_PUBLIC_KEY_FORMAT', message: 'Essa não parece uma Public Key de produção. Ela começa com APP_USR- e fica logo acima do Access Token, em "Credenciais de produção".' };
  return { ok: true, accessToken, publicKey, userIdHint: userIdOf(accessToken) };
}

/** Como a taxa da loja online é recebida: separada pelo Mercado Pago (OAuth) ou lançada na fatura do Balcão (token). */
export const feeCollectionOf = (mode: MpMode | null | undefined): FeeCollection => (mode === 'token' ? 'invoice' : 'split');

/** marketplace_fee que vai na ordem do Checkout Pro: só no OAuth (no modo token o Mercado Pago recusaria ou ignoraria). */
export const marketplaceFeeFor = (collection: FeeCollection, feeCents: number): number => (collection === 'split' ? Math.max(0, feeCents) : 0);

/**
 * Consulta automática das cobranças pendentes no modo token. A cada ~10 s nos primeiros 5 min, depois 20 s até 15 min,
 * 30 s até 30 min; depois disso para (a rotina de 1 min do caixa e a expiração do pedido seguem valendo).
 * Erro do Mercado Pago (limite, instabilidade) dobra o intervalo, até 2 min.
 */
export const POLL_WINDOW_MS = 30 * 60_000;
export function pollDelayMs(ageMs: number, fails: number): number {
  const base = ageMs < 5 * 60_000 ? 10_000 : ageMs < 15 * 60_000 ? 20_000 : 30_000;
  return Math.min(120_000, base * 2 ** Math.min(Math.max(0, fails), 4));
}
/** Próxima consulta, ou null quando a janela de 30 min acabou. */
export function nextPollAt(createdAt: Date, now: Date, fails: number): Date | null {
  const age = now.getTime() - createdAt.getTime();
  if (age >= POLL_WINDOW_MS) return null;
  return new Date(now.getTime() + pollDelayMs(age, fails));
}

/** Resultados que encerram a consulta automática (pago, recusado, cancelado, expirado, já resolvido). */
const FINAL = new Set(['applied', 'already_paid', 'not_paid', 'refunded', 'paid_twice', 'paid', 'failed', 'canceled', 'cancelled', 'expired', 'gone', 'not_this_order', 'not_this_tab', 'wrong_account', 'amount_mismatch']);
export const isFinalOutcome = (outcome: string) => FINAL.has(outcome);
