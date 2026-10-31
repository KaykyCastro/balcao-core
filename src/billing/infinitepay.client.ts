import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface CheckoutLinkInput {
  orderNsu: string;
  amountCents: number;
  description: string;
  redirectUrl?: string;
  webhookUrl?: string;
  customer?: { name?: string; email?: string; phone_number?: string };
  /** Loja online: InfiniteTag DO LOJISTA (o dinheiro cai direto na conta dele). Vazio = conta do ERP. */
  handle?: string;
  /** Vários itens (produtos + frete). Sem isso, vira um item único com `amountCents`. */
  items?: { quantity: number; price: number; description: string }[];
}
export interface PaymentCheck {
  paid: boolean;
  amountCents?: number;
  paidAmountCents?: number;
  captureMethod?: string;
}

/**
 * Cliente mínimo do Checkout Integrado da InfinitePay (conta DO ERP, via InfiniteTag).
 * O dinheiro das vendas dos clientes nunca passa por aqui, só a taxa do ERP.
 *
 * A InfinitePay NÃO assina o webhook. Por isso: (1) a URL do webhook leva um token HMAC por fatura e
 * (2) nenhuma fatura é baixada sem reconfirmar o pagamento no `payment_check` (servidor a servidor).
 */
@Injectable()
export class InfinitePayClient {
  private readonly logger = new Logger(InfinitePayClient.name);
  constructor(private readonly config: ConfigService) {}

  private get base(): string {
    return (this.config.get<string>('INFINITEPAY_API_URL') ?? 'https://api.checkout.infinitepay.io').replace(/\/$/, '');
  }
  get handle(): string {
    const h = this.config.get<string>('INFINITEPAY_HANDLE')?.trim().replace(/^\$/, '');
    if (!h) throw new ServiceUnavailableException('Pagamento indisponível: InfinitePay não configurado');
    return h;
  }
  private get secret(): string {
    const s = this.config.get<string>('INFINITEPAY_WEBHOOK_SECRET') ?? (this.config.get('NODE_ENV') === 'production' ? '' : 'dev-only-webhook-secret');
    if (!s) throw new ServiceUnavailableException('Pagamento indisponível: segredo do webhook não configurado');
    return s;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const apiKey = this.config.get<string>('INFINITEPAY_API_KEY');
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.logger.error(`Falha de rede na InfinitePay: ${(e as Error).message}`);
      throw new BadGatewayException('Não foi possível falar com a InfinitePay');
    }
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      this.logger.error(`InfinitePay ${res.status} em ${path}: ${JSON.stringify(json)}`);
      throw new BadGatewayException(`InfinitePay recusou a requisição (${res.status})`);
    }
    return json;
  }

  /** Token que acompanha a URL do webhook: só quem conhece o segredo consegue forjar a URL de uma fatura. */
  webhookToken(orderNsu: string, scope = 'infinitepay'): string {
    return createHmac('sha256', this.secret).update(`${scope}:${orderNsu}`).digest('hex').slice(0, 40);
  }
  verifyWebhookToken(orderNsu: string, token: unknown, scope = 'infinitepay'): boolean {
    if (typeof token !== 'string') return false;
    const a = Buffer.from(this.webhookToken(orderNsu, scope));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async createCheckoutLink(input: CheckoutLinkInput): Promise<{ url: string; slug: string | null }> {
    const out = await this.post<{ checkout_url?: string; link?: string; url?: string; slug?: string }>('/links', {
      handle: input.handle ? normalizeHandle(input.handle) : this.handle,
      order_nsu: input.orderNsu,
      items: input.items?.length ? input.items : [{ quantity: 1, price: input.amountCents, description: input.description }],
      ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
      ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
      ...(input.customer ? { customer: input.customer } : {}),
    });
    const url = out.checkout_url ?? out.link ?? out.url;
    if (!url || !/^https:\/\//i.test(url)) {
      this.logger.error(`Resposta inesperada da InfinitePay ao criar o link: ${JSON.stringify(out)}`);
      throw new BadGatewayException('A InfinitePay não devolveu o link de pagamento');
    }
    return { url, slug: out.slug ?? null };
  }

  /** Confirma o pagamento direto na InfinitePay. Nunca confie no corpo do webhook/redirect. */
  async paymentCheck(p: { orderNsu: string; transactionNsu: string; slug: string; handle?: string }): Promise<PaymentCheck> {
    const r = await this.post<{ paid?: boolean; success?: boolean; amount?: number; paid_amount?: number; capture_method?: string }>('/payment_check', {
      handle: p.handle ? normalizeHandle(p.handle) : this.handle,
      order_nsu: p.orderNsu,
      transaction_nsu: p.transactionNsu,
      slug: p.slug,
    });
    return { paid: r.paid === true, amountCents: r.amount, paidAmountCents: r.paid_amount, captureMethod: r.capture_method };
  }
}

/** InfiniteTag sem o "$", minúscula. Aceita letras, números, ponto, hífen e sublinhado. */
export const HANDLE_RE = /^[a-z0-9._-]{3,40}$/;
export function normalizeHandle(h: string): string {
  const v = h.trim().replace(/^\$/, '').toLowerCase();
  if (!HANDLE_RE.test(v)) throw new BadGatewayException('InfiniteTag da loja inválida');
  return v;
}
