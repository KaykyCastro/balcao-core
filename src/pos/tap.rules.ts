import { timingSafeEqual } from 'crypto';

/**
 * InfiniteTap (InfinitePay): o celular do lojista vira maquininha. O app do Balcão abre o app da InfinitePay por deep
 * link com o valor e um `order_id`; ao terminar, a InfinitePay reabre o Balcão no `result_url` com o resultado.
 *
 * A InfinitePay NÃO oferece como o servidor confirmar um Tap (sem API de consulta, webhook ou assinatura): o resultado
 * só chega pelo deep link, no próprio aparelho. Por isso as travas ficam aqui:
 * - o servidor calcula o valor e cria a cobrança; o `order_id` é um segredo aleatório de uso único dessa cobrança;
 * - só vale o retorno com o mesmo `order_id`, dentro do prazo, de uma cobrança ainda pendente;
 * - a conta InfinitePay que volta (`handle`, documento) tem de ser a configurada pela loja (o deep link também manda
 *   `handle`/`doc_number`, e a própria InfinitePay recusa se o app estiver logado em outra conta);
 * - cada NSU vale uma vez só (índice único), então um retorno real não paga duas vendas.
 */

export const TAP_REFERRER = 'Balcao';
export const TAP_MIN_CENTS = 100; // R$ 1,00 (mínimo da InfinitePay, também por parcela)

export const normalizeHandle = (h: string | null | undefined) => (h ?? '').trim().replace(/^\$/, '').toLowerCase();
export const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** InfiniteTag: letras, números, ponto, traço e sublinhado (sem o $). */
export const HANDLE_RE = /^[a-z0-9._-]{2,40}$/;
/** Documento da conta: CPF (11) ou CNPJ (14) só com números. */
export const docOk = (d: string) => d === '' || d.length === 11 || d.length === 14;

/**
 * Para onde a InfinitePay devolve: só o esquema do próprio app (`balcao://`) ou, no Expo Go em desenvolvimento,
 * `exp://<host>/--/`. Nunca um site (http/https), para o resultado não sair do aparelho.
 */
export function returnUrlOk(url: string, allowExpoGo: boolean): boolean {
  if (url.length > 200) return false;
  if (/^balcao:\/\/[A-Za-z0-9/_-]*$/.test(url)) return true;
  return allowExpoGo && /^exps?:\/\/[A-Za-z0-9.:-]+\/--\/[A-Za-z0-9/_-]*$/.test(url);
}

/** Parcelas possíveis: até 12, e cada parcela com pelo menos R$ 1,00. */
export const maxInstallments = (amountCents: number) => Math.max(1, Math.min(12, Math.floor(amountCents / TAP_MIN_CENTS)));

export function tapDeeplink(p: { amountCents: number; method: 'credit' | 'debit'; installments: number; orderId: string; resultUrl: string; handle: string; doc?: string }): string {
  const q = new URLSearchParams({
    amount: String(p.amountCents),
    payment_method: p.method,
    installments: String(p.method === 'credit' ? p.installments : 1),
    order_id: p.orderId,
    result_url: p.resultUrl,
    app_client_referrer: TAP_REFERRER,
    handle: normalizeHandle(p.handle),
    ...(p.doc ? { doc_number: digits(p.doc) } : {}),
    af_force_deeplink: 'true',
  });
  return `infinitepaydash://infinitetap-app?${q.toString()}`;
}

export interface TapResultIn {
  orderId: string; nsu?: string; aut?: string; cardBrand?: string; handle?: string; merchantDocument?: string; warning?: string;
}
export type TapVerdict =
  | { ok: true; nsu: string; aut: string; brand: string }
  | { ok: false; reason: string; code: 'TAP_ORDER_MISMATCH' | 'TAP_EXPIRED' | 'TAP_NOT_PENDING' | 'TAP_WRONG_ACCOUNT' | 'TAP_NOT_PAID' };

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Decide se o retorno do InfiniteTap paga a cobrança. Puro: quem chama garante que a cobrança é desta loja e grava
 * o resultado de forma atômica (status pendente → pago, NSU único).
 */
export function judgeTapResult(
  charge: { orderId: string; status: string; expiresAt: Date },
  cfg: { handle: string; doc: string },
  r: TapResultIn,
  now = Date.now(),
): TapVerdict {
  if (!r.orderId || !sameSecret(r.orderId, charge.orderId)) return { ok: false, code: 'TAP_ORDER_MISMATCH', reason: 'Este retorno não é da cobrança aberta pelo app.' };
  if (charge.status !== 'pending') return { ok: false, code: 'TAP_NOT_PENDING', reason: 'Esta cobrança já foi encerrada.' };
  if (now > charge.expiresAt.getTime() + 2 * 60_000) return { ok: false, code: 'TAP_EXPIRED', reason: 'O prazo desta cobrança acabou. Faça uma nova cobrança.' };
  const h = normalizeHandle(r.handle);
  if (!h || h !== normalizeHandle(cfg.handle)) return { ok: false, code: 'TAP_WRONG_ACCOUNT', reason: 'O pagamento voltou de outra conta InfinitePay, diferente da configurada na loja.' };
  const d = digits(r.merchantDocument);
  if (cfg.doc && d && d !== digits(cfg.doc)) return { ok: false, code: 'TAP_WRONG_ACCOUNT', reason: 'O documento da conta InfinitePay não confere com o configurado na loja.' };
  const nsu = (r.nsu ?? '').trim(); const aut = (r.aut ?? '').trim();
  // A InfinitePay não manda um campo de status: sem aviso, com NSU e autorização, a transação foi aprovada.
  if ((r.warning ?? '').trim() || !/^[A-Za-z0-9-]{6,64}$/.test(nsu) || !/^[A-Za-z0-9]{1,20}$/.test(aut)) {
    return { ok: false, code: 'TAP_NOT_PAID', reason: r.warning?.trim() ? `A InfinitePay não concluiu o pagamento: ${r.warning.trim().slice(0, 120)}` : 'A InfinitePay não confirmou o pagamento.' };
  }
  return { ok: true, nsu, aut, brand: (r.cardBrand ?? '').trim().toLowerCase().slice(0, 20) };
}
