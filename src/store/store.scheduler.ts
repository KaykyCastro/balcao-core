import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderService } from './order.service';

@Injectable()
export class StoreScheduler {
  private readonly logger = new Logger(StoreScheduler.name);
  constructor(private readonly orders: OrderService) {}

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
}
