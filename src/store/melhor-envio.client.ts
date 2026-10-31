import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
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
}

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
