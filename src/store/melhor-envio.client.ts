import { BadGatewayException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MeProduct { id: string; widthCm: number; heightCm: number; lengthCm: number; weightGrams: number; insuranceCents: number; quantity: number }
export interface MeQuote { id: number; name: string; company?: string; priceCents: number; minDays: number; maxDays: number }

/**
 * Cotação de frete no Melhor Envio (Correios, Jadlog, Loggi, etc.) com o token DO LOJISTA.
 * Só cotação: a etiqueta continua sendo gerada pelo lojista no painel do Melhor Envio.
 */
@Injectable()
export class MelhorEnvioClient {
  private readonly logger = new Logger(MelhorEnvioClient.name);
  constructor(private readonly config: ConfigService) {}

  private base(sandbox: boolean) {
    return sandbox ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br';
  }

  async quote(p: { token: string; sandbox: boolean; fromCep: string; toCep: string; products: MeProduct[] }): Promise<MeQuote[]> {
    const contact = this.config.get<string>('MAIL_FROM')?.match(/<([^>]+)>/)?.[1] ?? 'contato@balcao.app';
    let res: Response;
    try {
      res = await fetch(`${this.base(p.sandbox)}/api/v2/me/shipment/calculate`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${p.token}`, 'User-Agent': `Balcao ERP (${contact})` },
        body: JSON.stringify({
          from: { postal_code: p.fromCep },
          to: { postal_code: p.toCep },
          products: p.products.map((x) => ({
            id: x.id, width: x.widthCm, height: x.heightCm, length: x.lengthCm,
            weight: Math.max(0.01, x.weightGrams / 1000), insurance_value: x.insuranceCents / 100, quantity: x.quantity,
          })),
          options: { receipt: false, own_hand: false },
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (e) {
      this.logger.warn(`Melhor Envio sem resposta: ${(e as Error).message}`);
      throw new BadGatewayException('Não foi possível calcular o frete agora');
    }
    const json = (await res.json().catch(() => null)) as unknown;
    if (res.status === 401) throw new BadGatewayException('Token do Melhor Envio inválido ou expirado');
    if (!res.ok || !Array.isArray(json)) {
      this.logger.warn(`Melhor Envio ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`);
      throw new BadGatewayException('O Melhor Envio não devolveu a cotação');
    }
    return parseQuotes(json);
  }

  // ------------------------------------------------------------------ etiquetas (debitam o saldo da carteira do lojista no Melhor Envio)

  private async call<T>(sandbox: boolean, token: string, path: string, body: unknown): Promise<T> {
    const contact = this.config.get<string>('MAIL_FROM')?.match(/<([^>]+)>/)?.[1] ?? 'contato@balcao.app';
    let res: Response;
    try {
      res = await fetch(`${this.base(sandbox)}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': `Balcao ERP (${contact})` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      this.logger.warn(`Melhor Envio sem resposta (${path}): ${(e as Error).message}`);
      throw new BadGatewayException('O Melhor Envio não respondeu. Tente de novo em instantes.');
    }
    const json = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string; errors?: Record<string, string[]> };
    if (res.status === 401) throw new BadGatewayException('Token do Melhor Envio inválido ou expirado. Gere outro em Loja online → Entrega.');
    if (!res.ok) {
      this.logger.warn(`Melhor Envio ${res.status} em ${path}: ${JSON.stringify(json).slice(0, 400)}`);
      const detail = json?.errors ? Object.values(json.errors).flat().join(' ') : json?.message || json?.error || '';
      throw new UnprocessableEntityException(`Melhor Envio: ${detail || `erro ${res.status}`}`.slice(0, 300));
    }
    return json;
  }

  /** Põe o envio no carrinho do Melhor Envio. Devolve o id do envio (usado em compra, etiqueta e rastreio). */
  async addToCart(p: MeLabelInput): Promise<{ id: string; protocol: string; priceCents: number }> {
    const r = await this.call<Record<string, any>>(p.sandbox, p.token, '/api/v2/me/cart', {
      service: p.serviceId,
      from: p.from, to: p.to,
      products: p.products.map((x) => ({ name: x.name.slice(0, 100), quantity: x.quantity, unitary_value: x.unitCents / 100 })),
      volumes: [{ height: p.volume.heightCm, width: p.volume.widthCm, length: p.volume.lengthCm, weight: Math.max(0.01, p.volume.weightGrams / 1000) }],
      options: {
        insurance_value: p.insuranceCents / 100, receipt: false, own_hand: false, reverse: false,
        non_commercial: !p.invoiceKey, ...(p.invoiceKey ? { invoice: { key: p.invoiceKey } } : {}),
        platform: 'Balcão', tags: [{ tag: p.tag, url: null }],
      },
    });
    return { id: String(r.id), protocol: String(r.protocol ?? ''), priceCents: Math.round(Number(r.price ?? 0) * 100) };
  }

  /** Compra (debita a carteira), gera e devolve o link para imprimir. */
  async buy(sandbox: boolean, token: string, ids: string[]) { await this.call(sandbox, token, '/api/v2/me/shipment/checkout', { orders: ids }); }
  async generate(sandbox: boolean, token: string, ids: string[]) { await this.call(sandbox, token, '/api/v2/me/shipment/generate', { orders: ids }); }
  async printUrl(sandbox: boolean, token: string, ids: string[]): Promise<string> {
    const r = await this.call<{ url?: string }>(sandbox, token, '/api/v2/me/shipment/print', { mode: 'public', orders: ids });
    if (!r.url) throw new BadGatewayException('O Melhor Envio não devolveu o link da etiqueta');
    return r.url;
  }
  async tracking(sandbox: boolean, token: string, ids: string[]): Promise<Record<string, MeTracking>> {
    const r = await this.call<Record<string, Record<string, any>>>(sandbox, token, '/api/v2/me/shipment/tracking', { orders: ids });
    return Object.fromEntries(Object.entries(r ?? {}).map(([id, t]) => [id, { status: String(t?.status ?? ''), tracking: t?.tracking ? String(t.tracking) : '', postedAt: t?.posted_at ?? null, deliveredAt: t?.delivered_at ?? null }]));
  }
  async cancelLabel(sandbox: boolean, token: string, id: string, description: string) {
    await this.call(sandbox, token, '/api/v2/me/shipment/cancel', { order: { id, reason_id: '2', description: description.slice(0, 255) } });
  }
}

export interface MeAddress { name: string; phone: string; email: string; document?: string; company_document?: string; address: string; number: string; complement?: string; district: string; city: string; state_abbr: string; postal_code: string; country_id: 'BR' }
export interface MeLabelInput {
  sandbox: boolean; token: string; serviceId: number; from: MeAddress; to: MeAddress;
  products: { name: string; quantity: number; unitCents: number }[];
  volume: { heightCm: number; widthCm: number; lengthCm: number; weightGrams: number };
  insuranceCents: number; invoiceKey?: string; tag: string;
}
/** status do Melhor Envio: pending, released (paga), posted, delivered, canceled, undelivered. */
export interface MeTracking { status: string; tracking: string; postedAt: string | null; deliveredAt: string | null }

/** Converte a resposta do Melhor Envio; ignora serviços com erro ou sem preço. */
export function parseQuotes(rows: unknown[]): MeQuote[] {
  const out: MeQuote[] = [];
  for (const r of rows as Record<string, any>[]) {
    if (!r || r.error) continue;
    const price = Number(r.custom_price ?? r.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const min = Number(r.custom_delivery_range?.min ?? r.delivery_range?.min ?? r.custom_delivery_time ?? r.delivery_time);
    const max = Number(r.custom_delivery_range?.max ?? r.delivery_range?.max ?? r.custom_delivery_time ?? r.delivery_time);
    out.push({
      id: Number(r.id), name: String(r.name ?? 'Envio'), company: r.company?.name ? String(r.company.name) : undefined,
      priceCents: Math.round(price * 100), minDays: Number.isFinite(min) ? min : 0, maxDays: Number.isFinite(max) ? max : Number.isFinite(min) ? min : 0,
    });
  }
  return out.sort((a, b) => a.priceCents - b.priceCents);
}
