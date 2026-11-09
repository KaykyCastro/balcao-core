import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type StoneState = 'pending' | 'paid' | 'failed';
export interface StoneOrder { id: string; status: string; state: StoneState; amountCents: number; brand: string | null; installments: number | null; authCode: string | null; method: string | null }

/**
 * Stone Connect 2.0 (API Pagar.me): o pedido vai direto para a maquininha Stone pelo número de série.
 * Exige o Stone Partner Program: o Balcão precisa do `ServiceRefererName` (STONE_SERVICE_REFERER_NAME)
 * e o lojista, da chave secreta (sk_) da conta Pagar.me/Stone dele.
 */
@Injectable()
export class StoneClient {
  private readonly logger = new Logger(StoneClient.name);
  constructor(private readonly config: ConfigService) {}

  get partnerReady() { return !!this.config.get<string>('STONE_SERVICE_REFERER_NAME'); }

  private async call<T>(method: string, path: string, sk: string, body?: unknown): Promise<T> {
    const referer = this.config.get<string>('STONE_SERVICE_REFERER_NAME');
    if (!referer) throw new ServiceUnavailableException('Maquininha Stone indisponível: o Balcão ainda não foi habilitado no Stone Partner Program (STONE_SERVICE_REFERER_NAME).');
    let res: Response;
    try {
      res = await fetch(`https://api.pagar.me/core/v5${path}`, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${sk}:`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json', ServiceRefererName: referer },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.logger.error(`Stone sem resposta (${path}): ${(e as Error).message}`);
      throw new BadGatewayException('Não foi possível falar com a Stone');
    }
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) {
      this.logger.error(`Stone ${res.status} em ${path}: ${JSON.stringify(json).slice(0, 300)}`);
      if (res.status === 401) throw new BadGatewayException('Chave da Stone/Pagar.me recusada. Confira em Configurações → Pagamentos no balcão.');
      throw new BadGatewayException(`A Stone recusou a cobrança (${res.status})`);
    }
    return json;
  }

  /** Pedido direto: a maquininha com esse número de série abre a tela de pagamento sozinha. */
  async createOrder(p: { sk: string; serial: string; amountCents: number; reference: string; type: 'credit' | 'debit' | 'pix'; installments?: number; title: string }): Promise<StoneOrder> {
    const r = await this.call<Record<string, any>>('POST', '/orders', p.sk, {
      code: p.reference, closed: false,
      customer: { name: 'Cliente do balcão' },
      items: [{ amount: p.amountCents, description: p.title.slice(0, 64), quantity: 1, code: p.reference }],
      poi_payment_settings: {
        visible: true, print_order_receipt: false, devices_serial_number: [p.serial], display_name: p.title.slice(0, 30),
        payment_setup: { type: p.type, installments: p.type === 'credit' ? Math.max(1, p.installments ?? 1) : 1, installment_type: 'merchant' },
      },
    });
    return stoneOrder(r);
  }

  async order(sk: string, id: string): Promise<StoneOrder> { return stoneOrder(await this.call<Record<string, any>>('GET', `/orders/${encodeURIComponent(id)}`, sk)); }

  /** Fecha o pedido (pago some da fila da maquininha; cancelado desiste da cobrança). */
  async close(sk: string, id: string, status: 'paid' | 'canceled'): Promise<void> { await this.call('PATCH', `/orders/${encodeURIComponent(id)}/closed`, sk, { status }); }
}

export function stoneOrder(r: Record<string, any>): StoneOrder {
  const ch = r?.charges?.[0] ?? {};
  const tx = ch.last_transaction ?? {};
  const st = String(r?.status ?? ''), cs = String(ch.status ?? '');
  const paid = st === 'paid' || cs === 'paid';
  const failed = ['canceled', 'failed'].includes(st) || ['canceled', 'failed'].includes(cs);
  return {
    id: String(r?.id ?? ''), status: st, state: paid ? 'paid' : failed ? 'failed' : 'pending', amountCents: Number(ch.paid_amount ?? ch.amount ?? r?.amount ?? 0),
    brand: tx.card?.brand ?? null, installments: tx.installments != null ? Number(tx.installments) : null, authCode: tx.acquirer_auth_code ?? null, method: ch.payment_method ?? null,
  };
}
