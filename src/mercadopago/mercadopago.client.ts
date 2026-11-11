import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MercadoPagoConfig, MercadoPagoError, Order as MpOrderClient } from 'mercadopago';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface MpTokens { accessToken: string; refreshToken: string; userId: string; publicKey: string; expiresAt: Date }
export interface MpPreferenceInput {
  accessToken: string;
  /** Vai em `external_reference`: id do pedido ou da fatura. Também compõe a chave de idempotência. */
  orderId: string;
  /** `categoryId`: categoria do Mercado Pago (ex.: services, others); `description`: texto do item (padrão: o título). */
  items: { title: string; quantity: number; unitCents: number; description?: string; categoryId?: string }[];
  /** Comissão do Balcão (loja online). Ausente/0 = sem comissão (faturas do sistema). */
  marketplaceFeeCents?: number;
  /** `document`: CPF (11) ou CNPJ (14) só com números; endereço quando houver entrega. */
  payer: { name: string; email?: string; phone?: string; document?: string; address?: { cep: string; street: string; number: string } | null; registeredAt?: Date | null };
  /** Máximo de parcelas no cartão (as que a loja oferece). */
  maxInstallments?: number;
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

/** Texto da fatura do cartão: sem acento, só letras, números e espaço, até 22 caracteres (limite das bandeiras). */
export function statementDescriptorOf(name?: string | null): string {
  return (name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 22).trim().toUpperCase();
}

/**
 * Pagador do Checkout Pro com o que a avaliação de qualidade pede: nome e sobrenome separados, e-mail, telefone,
 * CPF/CNPJ e endereço (quando houver). Só vai o que existe; nada é inventado.
 */
export function payerOf(p: MpPreferenceInput['payer']) {
  const parts = p.name.trim().split(/\s+/);
  const doc = (p.document ?? '').replace(/\D/g, '');
  const phone = (p.phone ?? '').replace(/\D/g, '');
  return {
    name: parts[0] ?? '', ...(parts.length > 1 ? { surname: parts.slice(1).join(' ') } : {}),
    ...(p.email ? { email: p.email } : {}),
    ...(phone.length >= 10 ? { phone: { area_code: phone.slice(0, 2), number: phone.slice(2) } } : {}),
    ...(doc.length === 11 || doc.length === 14 ? { identification: { type: doc.length === 11 ? 'CPF' : 'CNPJ', number: doc } } : {}),
    ...(p.address?.cep ? { address: { zip_code: p.address.cep.replace(/\D/g, ''), street_name: p.address.street, street_number: p.address.number } } : {}),
  };
}

/** Id que o Balcão aceita como pagamento do Mercado Pago: número (pagamento antigo) ou ordem da API de Orders ("ORD…"). */
export const MP_PAYMENT_ID_RE = /^(\d{1,20}|ORD[A-Z0-9]{10,40})$/;
export const isOrderId = (id: string) => /^ORD[A-Z0-9]{10,40}$/.test(id);

/** Pagador no formato da API de Orders. Só vai o que existe; o e-mail é obrigatório quando o pagador vai. */
export function orderPayerOf(p: MpPreferenceInput['payer']) {
  const legacy = payerOf(p);
  return {
    ...(legacy.email ? { email: legacy.email } : {}),
    ...(legacy.name ? { first_name: legacy.name } : {}), ...(legacy.surname ? { last_name: legacy.surname } : {}),
    ...(legacy.phone ? { phone: legacy.phone } : {}),
    ...(legacy.identification ? { identification: legacy.identification } : {}),
    ...(legacy.address ? { address: legacy.address } : {}),
  };
}

/**
 * Ordem de Checkout Pro → o mesmo formato de pagamento que o resto do Balcão já confere (referência, conta, valor):
 * processada e creditada = "approved"; devolvida = "refunded"; falhou = "rejected"; cancelada/expirada = "cancelled".
 */
export function orderAsPayment(r: Record<string, any>): MpPayment {
  const st = String(r.status ?? ''), det = String(r.status_detail ?? '');
  const status = st === 'processed' && (det === 'accredited' || det === 'partially_refunded') ? 'approved'
    : st === 'refunded' ? 'refunded' : st === 'failed' ? 'rejected' : st === 'canceled' || st === 'expired' ? 'cancelled'
    : st === 'action_required' || st === 'processing' ? 'in_process' : st || 'pending';
  const pay = Array.isArray(r.transactions?.payments) ? r.transactions.payments[0] : null;
  return {
    id: String(r.id ?? ''), status, statusDetail: pay?.status_detail ? `${det}/${String(pay.status_detail)}` : det, externalReference: r.external_reference ? String(r.external_reference) : null,
    amountCents: cents(r.total_paid_amount ?? 0), collectorId: r.user_id != null ? String(r.user_id) : null,
    marketplaceFeeCents: cents(r.marketplace_fee ?? 0), method: pay?.payment_method?.type ? String(pay.payment_method.type) : null,
    approvedAt: status === 'approved' ? String(r.last_updated_date ?? '') || null : null,
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

  /**
   * ID de plataforma (qualidade da integração): o time de Partners do Mercado Pago gera e entrega depois de aprovar a
   * solução. Com MP_PLATFORM_ID definido, vai no cabeçalho x-platform-id de toda chamada com token.
   */
  private platformHeader(token?: string): Record<string, string> {
    const id = this.config.get<string>('MP_PLATFORM_ID')?.trim();
    return id && token ? { 'X-Platform-Id': id } : {};
  }

  /**
   * Configuração "online" das ordens (qualidade da integração): nome na fatura do cartão, URLs de retorno em HTTPS e 3DS
   * com liability shift. As URLs só vão quando o site está em HTTPS (o Mercado Pago recusa http).
   */
  private onlineConfig(statementDescriptor?: string) {
    const front = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '');
    const urls = front.startsWith('https://') ? { success_url: `${front}/app/vendas?pix=aprovado`, failure_url: `${front}/app/vendas?pix=recusado`, pending_url: `${front}/app/vendas?pix=pendente` } : {};
    const descriptor = statementDescriptorOf(statementDescriptor);
    return {
      ...(descriptor ? { statement_descriptor: descriptor } : {}),
      online: { ...urls, transaction_security: { validation: 'on_fraud_risk', liability_shift: 'required' } },
    };
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
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(idem ? { 'X-Idempotency-Key': idem } : {}), ...this.platformHeader(token), ...extra },
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
  /**
   * Link de autorização. Com `codeChallenge` usa PKCE (S256): funciona com o PKCE ligado ou desligado na aplicação do
   * Mercado Pago. Ligado, o Mercado Pago recusa o link sem code_challenge antes mesmo do login ("o aplicativo não está pronto").
   */
  authUrl(state: string, codeChallenge?: string): string {
    const { clientId, redirectUri } = this.app();
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', platform_id: 'mp', state, redirect_uri: redirectUri, ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}) });
    return `${AUTH}?${q}`;
  }

  private tokens(r: Record<string, unknown>): MpTokens {
    if (!r.access_token || !r.refresh_token) throw new BadGatewayException('O Mercado Pago não devolveu as credenciais');
    return {
      accessToken: String(r.access_token), refreshToken: String(r.refresh_token), userId: String(r.user_id ?? ''), publicKey: String(r.public_key ?? ''),
      expiresAt: new Date(Date.now() + Number(r.expires_in ?? 15_552_000) * 1000),
    };
  }

  async exchangeCode(code: string, codeVerifier?: string): Promise<MpTokens> {
    const { clientId, clientSecret, redirectUri } = this.app();
    return this.tokens(await this.call<Record<string, unknown>>('POST', '/oauth/token', { client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }));
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
  /**
   * SDK oficial do Mercado Pago (backend) para as ordens do Checkout Pro: criar, consultar e devolver. Leva o
   * MP_PLATFORM_ID (x-platform-id) quando definido e repete sozinho só em erro temporário (5xx/429), com a mesma chave
   * de idempotência. Os erros viram as mesmas mensagens do resto do Balcão.
   */
  private sdkOrders(accessToken: string) {
    const platformId = this.config.get<string>('MP_PLATFORM_ID')?.trim();
    return new MpOrderClient(new MercadoPagoConfig({ accessToken, options: { timeout: 15_000, maxRetries: 2, retryOn: [429, 500, 502, 503, 504], ...(platformId ? { platformId } : {}) } }));
  }
  private async sdk<T>(path: string, run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (e) {
      if (e instanceof MercadoPagoError) {
        this.logger.error(`Mercado Pago ${e.status} em ${path}: ${String(e.message).slice(0, 300)} ${JSON.stringify((e as { causes?: unknown }).causes ?? []).slice(0, 900)}`);
        if (e.status === 401) throw new BadGatewayException('A conexão com o Mercado Pago expirou. Conecte a conta de novo em Loja online → Pagamento.');
        throw new BadGatewayException(`O Mercado Pago recusou a requisição (${e.status}): ${JSON.stringify((e as { causes?: unknown }).causes ?? []).slice(0, 600)}`);
      }
      this.logger.error(`Mercado Pago sem resposta (${path}): ${(e as Error).message}`);
      throw new BadGatewayException('Não foi possível falar com o Mercado Pago');
    }
  }

  /**
   * Cobrança de Checkout Pro pela API de Orders (o modelo da aplicação certificada): POST /v1/orders com type "online" e
   * processing_mode "manual"; o comprador paga no `checkout_url`. O id devolvido é o da ordem ("ORD…"): é com ele que
   * `payment()` confere e `refund()` devolve. Os avisos chegam no webhook único do painel (evento Order), não por cobrança.
   * Se o Mercado Pago recusar algum campo opcional (400/422), tenta de novo só com o essencial.
   */
  async createPreference(p: MpPreferenceInput): Promise<{ id: string; initPoint: string }> {
    const items = p.items.map((i, k) => ({ title: i.title.slice(0, 250), quantity: i.quantity, unitCents: i.unitCents, description: (i.description ?? i.title).slice(0, 250), categoryId: i.categoryId ?? 'others', code: String(k + 1) }));
    const total = items.reduce((n, i) => n + i.unitCents * i.quantity, 0);
    const money = (c: number) => (c / 100).toFixed(2);
    const online = {
      success_url: p.backUrl, failure_url: p.backUrl, pending_url: p.backUrl, auto_return: 'approved',
      // Sem isso, a primeira recusa encerra a ordem e toda nova tentativa (outro cartão, Pix) é recusada também.
      retries: { allowed: true },
    };
    const minimal = {
      type: 'online', processing_mode: 'manual', total_amount: money(total), external_reference: p.orderId,
      items: items.map((i) => ({ title: i.title, unit_price: money(i.unitCents), quantity: i.quantity })),
      ...(p.marketplaceFeeCents ? { marketplace_fee: money(p.marketplaceFeeCents) } : {}),
      ...(p.payer.email ? { payer: { email: p.payer.email } } : {}),
      config: { online },
    };
    const descriptor = statementDescriptorOf(p.statementDescriptor);
    const minutes = p.expiresAt ? Math.max(30, Math.ceil((p.expiresAt.getTime() - Date.now()) / 60_000)) : 0;
    // Degrau do meio: só os campos de qualidade básicos e bem documentados (itens completos, pagador com nome,
    // nome na fatura, parcelas). Se a ordem completa for recusada por algum campo extra, estes pontos não se perdem.
    const payerName = orderPayerOf(p.payer);
    const safe = {
      ...minimal,
      description: (items.length === 1 ? items[0].title : items.map((i) => i.title).join(', ')).slice(0, 250),
      items: items.map((i) => ({ title: i.title, unit_price: money(i.unitCents), quantity: i.quantity, description: i.description, category_id: i.categoryId, external_code: i.code })),
      ...(p.payer.email ? { payer: { email: p.payer.email, ...(payerName.first_name ? { first_name: payerName.first_name } : {}), ...(payerName.last_name ? { last_name: payerName.last_name } : {}) } } : {}),
      config: {
        ...(descriptor ? { statement_descriptor: descriptor } : {}),
        online,
        ...(p.maxInstallments && p.maxInstallments > 0 ? { payment_method: { max_installments: Math.min(12, p.maxInstallments) } } : {}),
      },
    };
    const full = {
      ...safe,
      ...(p.payer.email ? { payer: orderPayerOf(p.payer) } : {}),
      ...(minutes ? { expiration_time: `PT${minutes}M` } : {}), // Pix gerado vence junto com a reserva
      // Data de cadastro do pagador no Balcão (ajuda a aprovação): conta do lojista nas faturas, cadastro do cliente nos pedidos.
      ...(p.payer.registeredAt ? { additional_info: { payer: { registration_date: new Date(p.payer.registeredAt).toISOString() } } } : {}),
      config: {
        ...(descriptor ? { statement_descriptor: descriptor } : {}),
        online: { ...online, transaction_security: { validation: 'on_fraud_risk', liability_shift: 'required' } },
        payment_method: { not_allowed_types: ['ticket'], ...(p.maxInstallments && p.maxInstallments > 0 ? { max_installments: Math.min(12, p.maxInstallments) } : {}) }, // sem boleto: demora e a reserva expira
      },
    };
    const idem = p.idem ?? `pref-${p.orderId}`;
    let r: Record<string, unknown>;
    const create = (body: Record<string, unknown>, key: string) => this.sdk('/v1/orders', () => this.sdkOrders(p.accessToken).create({ body: body as never, requestOptions: { idempotencyKey: key } }) as Promise<unknown>) as Promise<Record<string, unknown>>;
    const refused = (e: unknown) => e instanceof BadGatewayException && /\((400|422)\)/.test(e.message);
    try { r = await create(full, idem); }
    catch (e) {
      if (!refused(e)) throw e;
      this.logger.warn(`Ordem de checkout recusada com os campos opcionais; tentando com os campos básicos: ${(e as Error).message}`);
      try { r = await create(safe, `${idem}-s`); }
      catch (e2) {
        if (!refused(e2)) throw e2;
        this.logger.warn(`Ordem de checkout recusada também com os campos básicos; tentando só com o essencial: ${(e2 as Error).message}`);
        r = await create(minimal, `${idem}-b`);
      }
    }
    const initPoint = String(r.checkout_url ?? '');
    if (!/^https:\/\//.test(initPoint)) throw new BadGatewayException('O Mercado Pago não devolveu o link de pagamento');
    return { id: String(r.id ?? ''), initPoint };
  }

  /**
   * Cancela uma ordem que ninguém pagou (fatura que ganhou ordem nova, pedido que expirou). Só ordens em aberto:
   * erro do Mercado Pago aqui nunca derruba quem chamou (devolve false).
   */
  async cancelCheckoutOrder(orderId: string, accessToken: string): Promise<boolean> {
    if (!isOrderId(orderId)) return false;
    try { await this.sdk(`/v1/orders/${orderId}/cancel`, () => this.sdkOrders(accessToken).cancel({ id: orderId }) as Promise<unknown>); return true; }
    catch (e) { this.logger.warn(`Não deu para cancelar a ordem ${orderId}: ${(e as Error).message}`); return false; }
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
    if (isOrderId(id)) return orderAsPayment(await this.sdk(`/v1/orders/${id}`, () => this.sdkOrders(accessToken).get({ id }) as Promise<unknown>) as Record<string, any>);
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
    if (isOrderId(paymentId)) { await this.sdk(`/v1/orders/${paymentId}/refund`, () => this.sdkOrders(accessToken).refund({ id: paymentId, requestOptions: { idempotencyKey: idem } }) as Promise<unknown>); return; }
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
  async createPixOrder(p: { accessToken: string; amountCents: number; reference: string; idem: string; payerEmail: string; expiresMin?: number; statementDescriptor?: string }): Promise<MpOrder> {
    const body = {
      type: 'online', processing_mode: 'automatic', external_reference: p.reference, total_amount: (p.amountCents / 100).toFixed(2),
      payer: { email: p.payerEmail },
      transactions: { payments: [{ amount: (p.amountCents / 100).toFixed(2), payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: `PT${Math.max(30, p.expiresMin ?? 30)}M` }] },
    };
    try {
      return mpOrder(await this.call<Record<string, any>>('POST', '/v1/orders', { ...body, config: this.onlineConfig(p.statementDescriptor) }, p.accessToken, p.idem));
    } catch (e) {
      // Se o Mercado Pago recusar algum campo de qualidade (ex.: 3DS num Pix), o Pix do caixa não pode parar: manda sem eles.
      if (!(e instanceof BadGatewayException) || !/\((400|422)\)/.test(e.message)) throw e;
      this.logger.warn(`Ordem Pix recusada com config de qualidade; tentando sem: ${(e as Error).message}`);
      return mpOrder(await this.call<Record<string, any>>('POST', '/v1/orders', body, p.accessToken, `${p.idem}-b`));
    }
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
