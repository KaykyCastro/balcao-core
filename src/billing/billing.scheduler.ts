import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BillingService } from './billing.service';
import { BillingNoticeService } from './billing-notice.service';
import { AutopayService } from './autopay.service';
import { BILLING_TZ } from '../common/period';

@Injectable()
export class BillingScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingScheduler.name);
  constructor(private readonly billing: BillingService, private readonly notices: BillingNoticeService, private readonly autopay: AutopayService) {}

  /** Todo dia às 00:05 (Fortaleza): no dia 1º fatura o mês anterior (prazo de 15 dias); nos demais, aplica bloqueios. */
  @Cron('5 0 * * *', { timeZone: BILLING_TZ })
  async daily() {
    await this.run('daily', () => this.billing.runDailyClose());
    await this.run('autopay', () => this.autopay.prepareAll()); // fatura nova: o cartão cobra o valor dela no dia 3
  }

  /** 9h: avisos da fatura (saiu, faltam 3 dias, vence amanhã, venceu). */
  @Cron('0 9 * * *', { timeZone: BILLING_TZ })
  async reminders() { await this.run('avisos', () => this.notices.run().then(() => undefined)); }

  /** 8h e 18h: confere no Mercado Pago as cobranças no cartão e baixa as faturas pagas (se o webhook falhar). */
  @Cron('0 8,18 * * *', { timeZone: BILLING_TZ })
  async reconcile() { await this.run('conciliação', () => this.autopay.reconcileAll()); }

  /** De hora em hora: quem passou do prazo é bloqueado na hora certa, não só na madrugada. */
  @Cron('10 * * * *', { timeZone: BILLING_TZ })
  async hourly() { await this.run('hourly', () => this.billing.runBlockCheck()); }

  /** Recupera fechamentos perdidos se o servidor ficou fora do ar (a rotina é idempotente). */
  onApplicationBootstrap() { void this.run('bootstrap', () => this.billing.runDailyClose()); }

  private async run(origin: string, fn: () => Promise<void>) {
    try { await fn(); } catch (e) { this.logger.error(`Rotina de cobrança (${origin}) falhou: ${(e as Error).message}`); }
  }
}
