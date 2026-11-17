import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MpAuthError } from '../mercadopago/mercadopago.client';
import { MpPollService, type PollKind } from '../store/mp-poll.service';
import { OrderService } from '../store/order.service';
import { TabService } from '../store/tab.service';
import { PosService } from './pos.service';

/**
 * Consulta automática das cobranças do modo token (Checkout Pro da loja, conta da mesa pelo celular, Pix e Point do
 * caixa). Os avisos do Mercado Pago vão para a aplicação do lojista e podem não chegar ao Balcão, então a cada 10 s
 * o Balcão pergunta ele mesmo, por até 30 min, com intervalo crescente e backoff em erro (mp-token.rules.ts).
 *
 * - Uma rodada por vez neste processo (`running`) e, entre processos, a vez por cobrança (`MpPollService.claim`):
 *   a mesma cobrança nunca é consultada em paralelo (rotina, aviso e tela do caixa respeitam a mesma vez).
 * - Confirmar continua idempotente em cada serviço: pedido (troca de status atômica), conta da mesa (fecha uma vez),
 *   caixa (venda com chave pos:<id>). Aviso e consulta chegando juntos não duplicam venda, estoque nem taxa.
 * - Até 25 cobranças por rodada, uma de cada vez (respeita o limite de requisições do Mercado Pago).
 */
@Injectable()
export class MpPollScheduler {
  private readonly logger = new Logger('ConsultaMercadoPago');
  private running = false;
  constructor(private readonly polls: MpPollService, private readonly pos: PosService, private readonly orders: OrderService, private readonly tabs: TabService) {}

  @Interval(10_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.round(); }
    catch (e) { this.logger.error(`Rodada de consultas falhou: ${(e as Error).message}`); }
    finally { this.running = false; }
  }

  /** Uma rodada: consulta o que está na vez. Devolve quantas cobranças resolveram (para teste e log). */
  async round(): Promise<number> {
    let resolved = 0;
    for (const due of await this.polls.due(25)) {
      const row = await this.polls.claim(due.kind, due.refId);
      if (!row) continue; // outra consulta pegou a vez (ou a cobrança saiu da fila)
      try {
        const outcome = await this.check(row.kind, String(row.enterpriseId), String(row.refId));
        await this.polls.settle(row, outcome);
        if (outcome !== 'pending') { resolved++; this.logger.log(`${row.kind} ${String(row.refId)}: ${outcome}`); }
      } catch (e) {
        // Token recusado: a loja já foi marcada como inválida e avisada; não adianta insistir.
        if (e instanceof MpAuthError || (e as { response?: { code?: string } }).response?.code === 'MP_TOKEN_INVALID') { await this.polls.stop(row.kind, row.refId); continue; }
        this.logger.warn(`${row.kind} ${String(row.refId)}: consulta falhou (${(e as Error).message}); tentando mais tarde`);
        await this.polls.settle(row, 'error', true);
      }
    }
    return resolved;
  }

  private check(kind: PollKind, eid: string, id: string): Promise<string> {
    if (kind === 'pos') return this.pos.syncById(eid, id);
    if (kind === 'order') return this.orders.pollOnce(id);
    return this.tabs.pollOnce(id);
  }
}
