import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface MpTokens { accessToken: string; refreshToken: string; userId: string; publicKey: string; expiresAt: Date }
export interface MpPreferenceInput {
  accessToken: string;
  /** Vai em `external_reference`: id do pedido ou da fatura. Também compõe a chave de idempotência. */
  orderId: string;
  items: { title: string; quantity: number; unitCents: number }[];
  /** Comissão do Balcão (loja online). Ausente/0 = sem comissão (faturas do sistema). */
  marketplaceFeeCents?: number;
  payer: { name: string; email?: string; phone?: string };
  /** Chave de idempotência própria (padrão: pref-<orderId>). Comanda reaberta gera outra cobrança. */
  idem?: string;
  backUrl: string;
  notificationUrl?: string;
  expiresAt?: Date;
  statementDescriptor?: string;
}
export interface MpPayment {
  id: string; status: string; statusDetail: string; externalReference: string | null; amountCents: number;
  collectorId: string | null; marketplaceFeeCents: number; method: string | null; approvedAt: string | null;
}

const API = 'https://api.mercadopago.com';

export interface MpTerminal { id: string; posId: string | null; storeId: string | null; operatingMode: string }
export type MpOrderState = 'pending' | 'paid' | 'failed';
export interface MpOrder {
  id: string; status: string; statusDetail: string; state: MpOrderState; externalReference: string | null;
  paymentId: string | null; amountCents: number; method: string | null; methodType: string | null; installments: number | null;
  qrCode: string | null; qrBase64: string | null; ticketUrl: string | null;
}
/** Order do Mercado Pago → estado simples para o caixa. Pago = processada/creditada; falhou = cancelada, expirada, recusada ou devolvida. */
export function mpOrder(r: Record<string, any>): MpOrder {
  const pay = r?.transactions?.payments?.[0] ?? {};
  const pm = pay.payment_method ?? {};
  const st = String(r?.status ?? ''), ps = String(pay.status ?? ''), detail = String(r?.status_detail ?? pay.status_detail ?? '');
  const paid = st === 'processed' || ps === 'processed' || ps === 'approved' || detail === 'accredited';
  const failed = ['canceled', 'cancelled', 'expired', 'failed', 'refunded', 'rejected'].includes(st) || ['canceled', 'rejected', 'failed', 'refunded'].includes(ps);
  return {
    id: String(r?.id ?? ''), status: st, statusDetail: detail, state: paid ? 'paid' : failed ? 'failed' : 'pending',
    externalReference: r?.external_reference ? String(r.external_reference) : null,
    paymentId: pay.id ? String(pay.id) : null, amountCents: cents(pay.paid_amount ?? pay.amount ?? r?.total_amount),
    method: pm.id ? String(pm.id) : null, methodType: pm.type ? String(pm.type) : null, installments: pm.installments != null ? Number(pm.installments) : null,
    qrCode: pm.qr_code ?? null, qrBase64: pm.qr_code_base64 ?? null, ticketUrl: pm.ticket_url ?? null,
  };
}
const AUTH = 'https://auth.mercadopago.com.br/authorization';
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/**
 * Mercado Pago, único provedor de pagamentos do Balcão:
 *  - Faturas do sistema: cobradas na conta DO BALCÃO (MP_ACCESS_TOKEN).
 *  - Loja online (marketplace/split): o lojista conecta a conta dele (OAuth) e cada pagamento é criado NA CONTA DELE
 *    com `marketplace_fee`; o Mercado Pago separa sozinho a comissão do Balcão no momento do pagamento.
 * Credenciais só no servidor: MP_ACCESS_TOKEN, MP_CLIENT_ID, MP_CLIENT_SECRET, MP_REDIRECT_URI.
 */
/** Assinatura do Mercado Pago (sem nada do cartão: só estado, valor e próxima cobrança). */
export interface MpPreapproval { id: string; status: string; initPoint: string; externalReference: string | null; amountCents: number; nextPaymentDate: Date | null }
function preapproval(r: Record<string, any>): MpPreapproval {
  return {
    id: String(r.id ?? ''), status: String(r.status ?? ''), initPoint: String(r.init_point ?? ''), externalReference: r.external_reference ? String(r.external_reference) : null,
    amountCents: Math.round(Number(r.auto_recurring?.transaction_amount ?? 0) * 100), nextPaymentDate: r.next_payment_date ? new Date(r.next_payment_date) : null,
  };
}

@Injectable()
export class MercadoPagoClient {
  private readonly logger = new Logger(MercadoPagoClient.name);
  constructor(private readonly config: ConfigService) {}

  /** Token da conta do Balcão (recebe as faturas do sistema e é a dona da aplicação de marketplace). */
  get platformToken(): string {
    const t = this.config.get<string>('MP_ACCESS_TOKEN')?.trim();
    if (!t) throw new ServiceUnavailableException('Pagamento indisponível: MP_ACCESS_TOKEN não configurado');
    return t;
  }

  get configured() { return !!(this.config.get('MP_CLIENT_ID') && this.config.get('MP_CLIENT_SECRET') && this.config.get('MP_REDIRECT_URI')); }
  private app() {
    const clientId = this.config.get<string>('MP_CLIENT_ID'), clientSecret = this.config.get<string>('MP_CLIENT_SECRET'), redirectUri = this.config.get<string>('MP_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) throw new ServiceUnavailableException('Mercado Pago não configurado no servidor (MP_CLIENT_ID, MP_CLIENT_SECRET, MP_REDIRECT_URI)');
    return { clientId, clientSecret, redirectUri };
  }

  private async call<T>(method: string, path: string, body?: unknown, token?: string, idem?: string, extra?: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(idem ? { 'X-Idempotency-Key': idem } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.logger.error(`Mercado Pago sem resposta (${path}): ${(e as Error).message}`);
      throw new BadGatewayException('Não foi possível falar com o Mercado Pago');
    }
    const json = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
    if (!res.ok) {
      this.logger.error(`Mercado Pago ${res.status} em ${path}: ${JSON.stringify(json).slice(0, 400)}`);
      if (res.status === 401) throw new BadGatewayException('A conexão com o Mercado Pago expirou. Conecte a conta de novo em Loja online → Pagamento.');
      throw new BadGatewayException(`O Mercado Pago recusou a requisição (${res.status})`);
    }
    return json;
  }

  /** Link para o lojista autorizar o Balcão na conta Mercado Pago dele. */
  authUrl(state: string): string {
    const { clientId, redirectUri } = this.app();
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', platform_id: 'mp', state, redirect_uri: redirectUri });
    return `${AUTH}?${q}`;
  }

  private tokens(r: Record<string, unknown>): MpTokens {
    if (!r.access_token || !r.refresh_token) throw new BadGatewayException('O Mercado Pago não devolveu as credenciais');
    return {
      accessToken: String(r.access_token), refreshToken: String(r.refresh_token), userId: String(r.user_id ?? ''), publicKey: String(r.public_key ?? ''),
      expiresAt: new Date(Date.now() + Number(r.expires_in ?? 15_552_000) * 1000),
    };
  }

  async exchangeCode(code: string): Promise<MpTokens> {
    const { clientId, clientSecret, redirectUri } = this.app();
    return this.tokens(await this.call<Record<string, unknown>>('POST', '/oauth/token', { client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }));
  }

  async refresh(refreshToken: string): Promise<MpTokens> {
    const { clientId, clientSecret } = this.app();
    return this.tokens(await this.call<Record<string, unknown>>('POST', '/oauth/token', { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }));
  }

  async me(accessToken: string): Promise<{ id: string; nickname: string; email: string }> {
    const r = await this.call<Record<string, unknown>>('GET', '/users/me', undefined, accessToken);
    return { id: String(r.id ?? ''), nickname: String(r.nickname ?? ''), email: String(r.email ?? '') };
  }

  /** Checkout Pro na conta do lojista, com a comissão do Balcão (marketplace_fee) separada automaticamente. */
  async createPreference(p: MpPreferenceInput): Promise<{ id: string; initPoint: string }> {
    const r = await this.call<Record<string, unknown>>('POST', '/checkout/preferences', {
      items: p.items.map((i, k) => ({ id: String(k + 1), title: i.title.slice(0, 250), quantity: i.quantity, unit_price: i.unitCents / 100, currency_id: 'BRL' })),
      payer: { name: p.payer.name, ...(p.payer.email ? { email: p.payer.email } : {}), ...(p.payer.phone ? { phone: { area_code: p.payer.phone.slice(0, 2), number: p.payer.phone.slice(2) } } : {}) },
      external_reference: p.orderId,
      ...(p.marketplaceFeeCents ? { marketplace_fee: p.marketplaceFeeCents / 100 } : {}),
      back_urls: { success: p.backUrl, pending: p.backUrl, failure: p.backUrl },
      auto_return: 'approved',
      ...(p.notificationUrl ? { notification_url: p.notificationUrl } : {}),
      ...(p.expiresAt ? {
        expires: true,
        expiration_date_to: p.expiresAt.toISOString(),
        date_of_expiration: p.expiresAt.toISOString(), // Pix gerado vence junto com a reserva
      } : {}),
      ...(p.statementDescriptor ? { statement_descriptor: p.statementDescriptor.slice(0, 22) } : {}),
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }] }, // sem boleto: demora a compensar e a reserva expira
    }, p.accessToken, p.idem ?? `pref-${p.orderId}`);
    const initPoint = String(r.init_point ?? '');
    if (!/^https:\/\//.test(initPoint)) throw new BadGatewayException('O Mercado Pago não devolveu o link de pagamento');
    return { id: String(r.id ?? ''), initPoint };
  }

  // ------------------------------------------------------------------ assinatura (cobrança automática da fatura)
  // O cliente digita o cartão na página do Mercado Pago (init_point); o Balcão nunca recebe dados do cartão.

  /** Cria a assinatura mensal (fica 'pending' até o lojista autorizar o cartão no Mercado Pago). */
  async createPreapproval(p: { reason: string; externalReference: string; payerEmail: string; amountCents: number; startDate: Date; backUrl: string }): Promise<MpPreapproval> {
    const r = await this.call<Record<string, any>>('POST', '/preapproval', {
      reason: p.reason.slice(0, 120), external_reference: p.externalReference, payer_email: p.payerEmail, back_url: p.backUrl, status: 'pending',
      auto_recurring: { frequency: 1, frequency_type: 'months', start_date: p.startDate.toISOString(), transaction_amount: p.amountCents / 100, currency_id: 'BRL' },
    }, this.platformToken);
    return preapproval(r);
  }
  async getPreapproval(id: string): Promise<MpPreapproval> {
    return preapproval(await this.call<Record<string, any>>('GET', `/preapproval/${encodeURIComponent(id)}`, undefined, this.platformToken));
  }
  /** Ajusta o valor do próximo ciclo (a fatura do mês) e/ou pausa, reativa ou cancela. */
  async updatePreapproval(id: string, p: { amountCents?: number; status?: 'authorized' | 'paused' | 'cancelled' }): Promise<MpPreapproval> {
    return preapproval(await this.call<Record<string, any>>('PUT', `/preapproval/${encodeURIComponent(id)}`, {
      ...(p.amountCents ? { auto_recurring: { transaction_amount: p.amountCents / 100, currency_id: 'BRL' } } : {}), ...(p.status ? { status: p.status } : {}),
    }, this.platformToken));
  }
  /** Cobranças feitas por uma assinatura (cada uma aponta para um pagamento, que é conferido à parte). */
  async authorizedPayments(preapprovalId: string): Promise<{ id: string; paymentId: string | null; status: string; amountCents: number }[]> {
    const r = await this.call<{ results?: Record<string, any>[] }>('GET', `/authorized_payments/search?preapproval_id=${encodeURIComponent(preapprovalId)}&limit=50`, undefined, this.platformToken);
    return (r.results ?? []).map((x) => ({ id: String(x.id), paymentId: x.payment?.id != null ? String(x.payment.id) : null, status: String(x.payment?.status ?? x.status ?? ''), amountCents: cents(x.transaction_amount) }));
  }
  async authorizedPayment(id: string): Promise<{ id: string; preapprovalId: string; paymentId: string | null }> {
    const x = await this.call<Record<string, any>>('GET', `/authorized_payments/${encodeURIComponent(id)}`, undefined, this.platformToken);
    return { id: String(x.id), preapprovalId: String(x.preapproval_id ?? ''), paymentId: x.payment?.id != null ? String(x.payment.id) : null };
  }

  /** Consulta o pagamento direto no Mercado Pago (fonte da verdade; nunca confie no webhook ou no redirecionamento). */
  async payment(id: string, accessToken: string): Promise<MpPayment> {
    const r = await this.call<Record<string, any>>('GET', `/v1/payments/${encodeURIComponent(id)}`, undefined, accessToken);
    const fee = Array.isArray(r.fee_details) ? r.fee_details.filter((f: any) => f?.type === 'application_fee').reduce((s: number, f: any) => s + cents(f.amount), 0) : 0;
    return {
      id: String(r.id), status: String(r.status ?? ''), statusDetail: String(r.status_detail ?? ''), externalReference: r.external_reference ? String(r.external_reference) : null,
      amountCents: cents(r.transaction_amount), collectorId: r.collector_id != null ? String(r.collector_id) : null,
      marketplaceFeeCents: fee || cents(r.marketplace_fee), method: r.payment_type_id ? String(r.payment_type_id) : null, approvedAt: r.date_approved ?? null,
    };
  }

  /** Devolve o pagamento inteiro ao comprador (a comissão do marketplace volta junto). */
  async refund(paymentId: string, accessToken: string, idem: string): Promise<void> {
    await this.call('POST', `/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {}, accessToken, idem);
  }

  // ------------------------------------------------------------------ balcão: maquininha Point e Pix (API de Orders)

  /** Maquininhas Point da conta do lojista. */
  async terminals(accessToken: string): Promise<MpTerminal[]> {
    const r = await this.call<{ data?: { terminals?: Record<string, any>[] } }>('GET', '/terminals/v1/list?limit=50', undefined, accessToken);
    return (r.data?.terminals ?? []).map((t) => ({ id: String(t.id), posId: t.pos_id != null ? String(t.pos_id) : null, storeId: t.store_id != null ? String(t.store_id) : null, operatingMode: String(t.operating_mode ?? '') }));
  }

  /** Coloca a maquininha no modo PDV (recebe as cobranças do sistema). Depois é preciso reiniciar a maquininha. */
  async setPdvMode(accessToken: string, terminalId: string): Promise<void> {
    await this.call('PATCH', '/terminals/v1/setup', { terminals: [{ id: terminalId, operating_mode: 'PDV' }] }, accessToken);
  }

  /** Envia a cobrança para a maquininha. Valor em string com 2 casas, como a API pede. */
  async createPointOrder(p: { accessToken: string; terminalId: string; amountCents: number; reference: string; idem: string; type?: 'credit_card' | 'debit_card' | 'qr'; installments?: number; description?: string }): Promise<MpOrder> {
    const credit = p.type === 'credit_card';
    const body = {
      type: 'point', external_reference: p.reference, expiration_time: 'PT15M', description: p.description?.slice(0, 150),
      transactions: { payments: [{ amount: (p.amountCents / 100).toFixed(2) }] },
      config: {
        point: { terminal_id: p.terminalId, print_on_terminal: 'no_ticket' },
        ...(p.type ? { payment_method: { default_type: p.type, ...(credit && (p.installments ?? 1) > 1 ? { default_installments: p.installments, installments_cost: 'seller' } : {}) } } : {}),
      },
    };
    return mpOrder(await this.call<Record<string, any>>('POST', '/v1/orders', body, p.accessToken, p.idem));
  }

  /** Pix com QR dinâmico na conta do lojista: o Mercado Pago avisa quando cai. */
  async createPixOrder(p: { accessToken: string; amountCents: number; reference: string; idem: string; payerEmail: string; expiresMin?: number }): Promise<MpOrder> {
    const body = {
      type: 'online', processing_mode: 'automatic', external_reference: p.reference, total_amount: (p.amountCents / 100).toFixed(2),
      payer: { email: p.payerEmail },
      transactions: { payments: [{ amount: (p.amountCents / 100).toFixed(2), payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: `PT${Math.max(30, p.expiresMin ?? 30)}M` }] },
    };
    return mpOrder(await this.call<Record<string, any>>('POST', '/v1/orders', body, p.accessToken, p.idem));
  }

  async order(accessToken: string, id: string): Promise<MpOrder> {
    return mpOrder(await this.call<Record<string, any>>('GET', `/v1/orders/${encodeURIComponent(id)}`, undefined, accessToken));
  }

  /** Cancela a cobrança. Já na maquininha (at_terminal) o cancelamento é pedido e confirmado depois. */
  async cancelOrder(accessToken: string, id: string, idem: string): Promise<MpOrder> {
    return mpOrder(await this.call<Record<string, any>>('POST', `/v1/orders/${encodeURIComponent(id)}/cancel`, undefined, accessToken, idem, { 'x-allow-cancelable-status': 'at_terminal' }));
  }

  /**
   * Assinatura do webhook (x-signature: "ts=...,v1=..."), se MP_WEBHOOK_SECRET estiver definido.
   * Manifesto: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
   */
  verifySignature(dataId: string, requestId: string | undefined, header: string | undefined): boolean {
    const secret = this.config.get<string>('MP_WEBHOOK_SECRET');
    if (!secret) return true; // sem segredo: a segurança vem do token por pedido na URL + consulta do pagamento
    if (!header) return false;
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
    if (!parts.ts || !parts.v1) return false;
    const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
    const manifest = `id:${id};${requestId ? `request-id:${requestId};` : ''}ts:${parts.ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(parts.v1));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
