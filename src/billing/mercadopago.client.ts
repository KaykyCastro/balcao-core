import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

const MP_API = 'https://api.mercadopago.com';

export interface MpPayment {
  id: number | string;
  status: string; // pending | approved | authorized | in_process | rejected | cancelled | refunded | charged_back
  status_detail?: string;
  transaction_amount: number;
  external_reference?: string | null;
  date_of_expiration?: string | null;
  point_of_interaction?: {
    transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string };
  };
}

export interface CreatePixInput {
  amountCents: number;
  description: string;
  externalReference: string;
  payerEmail: string;
  payerDocument?: string; // CPF (11) ou CNPJ (14), só dígitos
  idempotencyKey: string;
  expiresAt: Date;
}

/** Fortaleza não tem horário de verão: UTC-3 fixo. MP exige ISO-8601 com offset. */
const toMpDate = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().replace('Z', '-03:00');

/**
 * Cliente mínimo da API do Mercado Pago. Usa a conta DO ERP (MP_ACCESS_TOKEN):
 * o dinheiro das vendas dos clientes nunca passa por aqui, só a taxa do ERP.
 */
@Injectable()
export class MercadoPagoClient {
  private readonly logger = new Logger(MercadoPagoClient.name);

  constructor(private readonly config: ConfigService) {}

  private get token(): string {
    const t = this.config.get<string>('MP_ACCESS_TOKEN');
    if (!t) throw new ServiceUnavailableException('Pagamento indisponível: Mercado Pago não configurado');
    return t;
  }

  private async request<T>(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${MP_API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...init.headers },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.logger.error(`Falha de rede no Mercado Pago: ${(e as Error).message}`);
      throw new BadGatewayException('Não foi possível falar com o Mercado Pago');
    }
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) {
      this.logger.error(`Mercado Pago ${res.status} em ${path}: ${JSON.stringify(body)}`);
      throw new BadGatewayException(`Mercado Pago recusou a requisição (${res.status})`);
    }
    return body;
  }

  createPixPayment(input: CreatePixInput): Promise<MpPayment> {
    const notificationUrl = this.config.get<string>('APP_URL')
      ? `${this.config.get<string>('APP_URL')}/billing/webhook/mercadopago`
      : undefined;
    const doc = input.payerDocument?.replace(/\D/g, '');
    return this.request<MpPayment>('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        transaction_amount: input.amountCents / 100,
        description: input.description,
        payment_method_id: 'pix',
        external_reference: input.externalReference,
        date_of_expiration: toMpDate(input.expiresAt),
        notification_url: notificationUrl,
        payer: {
          email: input.payerEmail,
          ...(doc && (doc.length === 11 || doc.length === 14)
            ? { identification: { type: doc.length === 14 ? 'CNPJ' : 'CPF', number: doc } }
            : {}),
        },
      }),
    });
  }

  getPayment(id: string): Promise<MpPayment> {
    return this.request<MpPayment>(`/v1/payments/${encodeURIComponent(id)}`, { method: 'GET' });
  }

  /**
   * Valida o header x-signature ("ts=...,v1=...") do webhook:
   * HMAC-SHA256 de `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` com o segredo do painel.
   * Sem segredo configurado só aceita fora de produção (a notificação é sempre
   * reconferida na API do MP, então isto é defesa em profundidade).
   */
  verifySignature(p: { xSignature?: string; xRequestId?: string; dataId: string }): boolean {
    const secret = this.config.get<string>('MP_WEBHOOK_SECRET');
    if (!secret) return this.config.get('NODE_ENV') !== 'production';
    if (!p.xSignature) return false;

    const parts = Object.fromEntries(
      p.xSignature.split(',').map((kv) => {
        const [k, ...v] = kv.trim().split('=');
        return [k, v.join('=')];
      }),
    );
    if (!parts.ts || !parts.v1) return false;

    const id = /^[a-z0-9]+$/i.test(p.dataId) ? p.dataId.toLowerCase() : p.dataId;
    const manifest = `id:${id};request-id:${p.xRequestId ?? ''};ts:${parts.ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
