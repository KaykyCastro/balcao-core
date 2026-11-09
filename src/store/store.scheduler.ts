import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderService } from './order.service';
import { ProtectionService } from './protection.service';
import { LogisticsService } from './logistics.service';

@Injectable()
export class StoreScheduler {
  private readonly logger = new Logger(StoreScheduler.name);
  constructor(private readonly orders: OrderService, private readonly protection: ProtectionService, private readonly logistics: LogisticsService) {}

  /** A cada 5 minutos: pedidos sem pagamento no prazo devolvem o estoque reservado. */
  @Cron('*/5 * * * *')
  async expire() {
    try {
      const n = await this.orders.expireStale();
      if (n) this.logger.log(`${n} pedido(s) expirado(s): estoque devolvido`);
    } catch (e) {
      this.logger.error(`Expiração de pedidos falhou: ${(e as Error).message}`);
    }
  }

  /** De hora em hora: Compra protegida (prazos de envio, confirmação automática, reclamações paradas). */
  @Cron('7 * * * *')
  async protect() {
    try {
      const r = await this.protection.tick();
      if (r.warned || r.cancelled || r.confirmed || r.escalated) this.logger.log(`Compra protegida: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`Compra protegida falhou: ${(e as Error).message}`);
    }
  }

  /** De hora em hora: rastreio das etiquetas do Melhor Envio (postado → Enviado, entregue → Entregue). */
  @Cron('23 * * * *')
  async track() {
    try {
      const r = await this.logistics.syncTracking();
      if (r.shipped || r.delivered) this.logger.log(`Rastreio: ${r.shipped} enviado(s), ${r.delivered} entregue(s)`);
    } catch (e) {
      this.logger.error(`Rastreio falhou: ${(e as Error).message}`);
    }
  }
}
