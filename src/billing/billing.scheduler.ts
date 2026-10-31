import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BillingService } from './billing.service';
import { BILLING_TZ } from '../common/period';

@Injectable()
export class BillingScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingScheduler.name);
  constructor(private readonly billing: BillingService) {}

  /** Todo dia às 00:05 (Fortaleza): no dia 1º fatura o mês anterior (prazo de 15 dias); nos demais, aplica bloqueios. */
  @Cron('5 0 * * *', { timeZone: BILLING_TZ })
  async daily() { await this.run('daily', () => this.billing.runDailyClose()); }

  /** De hora em hora: quem passou do prazo é bloqueado na hora certa, não só na madrugada. */
  @Cron('10 * * * *', { timeZone: BILLING_TZ })
  async hourly() { await this.run('hourly', () => this.billing.runBlockCheck()); }

  /** Recupera fechamentos perdidos se o servidor ficou fora do ar (a rotina é idempotente). */
  onApplicationBootstrap() { void this.run('bootstrap', () => this.billing.runDailyClose()); }

  private async run(origin: string, fn: () => Promise<void>) {
    try { await fn(); } catch (e) { this.logger.error(`Rotina de cobrança (${origin}) falhou: ${(e as Error).message}`); }
  }
}
