import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface MpTokens { accessToken: string; refreshToken: string; userId: string; publicKey: string; expiresAt: Date }
export interface MpPreferenceInput {
  accessToken: string;
  orderId: string;
  items: { title: string; quantity: number; unitCents: number }[];
  marketplaceFeeCents: number;
  payer: { name: string; email: string; phone: string };
  backUrl: string;
  notificationUrl?: string;
  expiresAt: Date;
  statementDescriptor?: string;
}
export interface MpPayment {
  id: string; status: string; statusDetail: string; externalReference: string | null; amountCents: number;
  collectorId: string | null; marketplaceFeeCents: number; method: string | null; approvedAt: string | null;
}

const API = 'https://api.mercadopago.com';
const AUTH = 'https://auth.mercadopago.com.br/authorization';
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/**
 * Mercado Pago no modo marketplace (split): o lojista conecta a conta dele (OAuth) e cada pagamento é criado
 * NA CONTA DELE com `marketplace_fee`. O Mercado Pago separa sozinho a comissão do Balcão no momento do pagamento.
 * Credenciais da aplicação (do Balcão) só no servidor: MP_CLIENT_ID, MP_CLIENT_SECRET, MP_REDIRECT_URI.
 */
@Injectable()
export class MercadoPagoClient {
  private readonly logger = new Logger(MercadoPagoClient.name);
  constructor(private readonly config: ConfigService) {}

  get configured() { return !!(this.config.get('MP_CLIENT_ID') && this.config.get('MP_CLIENT_SECRET') && this.config.get('MP_REDIRECT_URI')); }
  private app() {
    const clientId = this.config.get<string>('MP_CLIENT_ID'), clientSecret = this.config.get<string>('MP_CLIENT_SECRET'), redirectUri = this.config.get<string>('MP_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) throw new ServiceUnavailableException('Mercado Pago não configurado no servidor (MP_CLIENT_ID, MP_CLIENT_SECRET, MP_REDIRECT_URI)');
    return { clientId, clientSecret, redirectUri };
  }

  private async call<T>(method: string, path: string, body?: unknown, token?: string, idem?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(idem ? { 'X-Idempotency-Key': idem } : {}), ...(token && this.config.get<string>('MP_PLATFORM_ID')?.trim() ? { 'X-Platform-Id': this.config.get<string>('MP_PLATFORM_ID')!.trim() } : {}) },
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
      payer: { name: p.payer.name, email: p.payer.email, phone: { area_code: p.payer.phone.slice(0, 2), number: p.payer.phone.slice(2) } },
      external_reference: p.orderId,
      marketplace_fee: p.marketplaceFeeCents / 100,
      back_urls: { success: p.backUrl, pending: p.backUrl, failure: p.backUrl },
      auto_return: 'approved',
      ...(p.notificationUrl ? { notification_url: p.notificationUrl } : {}),
      expires: true,
      expiration_date_to: p.expiresAt.toISOString(),
      date_of_expiration: p.expiresAt.toISOString(), // Pix/boleto gerados vencem junto com a reserva
      ...(p.statementDescriptor ? { statement_descriptor: p.statementDescriptor.slice(0, 22) } : {}),
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }] }, // sem boleto: demora a compensar e a reserva expira
    }, p.accessToken, `pref-${p.orderId}`);
    const initPoint = String(r.init_point ?? '');
    if (!/^https:\/\//.test(initPoint)) throw new BadGatewayException('O Mercado Pago não devolveu o link de pagamento');
    return { id: String(r.id ?? ''), initPoint };
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
