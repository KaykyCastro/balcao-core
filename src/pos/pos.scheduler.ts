import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PosService } from './pos.service';

@Injectable()
export class PosScheduler {
  private readonly logger = new Logger(PosScheduler.name);
  constructor(private readonly pos: PosService) {}

  /** A cada minuto: cobrança paga com a tela do caixa fechada vira venda mesmo assim. */
  @Cron('* * * * *')
  async reconcile() {
    try { const n = await this.pos.reconcile(); if (n) this.logger.log(`${n} cobrança(s) do balcão atualizada(s)`); }
    catch (e) { this.logger.error(`Conferência das cobranças falhou: ${(e as Error).message}`); }
  }
}
