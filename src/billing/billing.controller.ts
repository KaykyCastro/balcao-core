import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { BillingService } from './billing.service';
import { BillingNoticeService } from './billing-notice.service';
import { AutopayService } from './autopay.service';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';

class NotifyDto {
  @IsOptional() @IsString() @MaxLength(30) whatsapp?: string;
  @IsBoolean() whatsappOn!: boolean;
}

class ConfirmDto {
  /** `order_id` (API de Orders) ou `payment_id` que o Mercado Pago devolve na volta do checkout. */
  @IsString() @Matches(/^(\d{1,20}|ORD[A-Z0-9]{10,40})$/)
  paymentId: string;
}

/** Tudo aqui continua acessível com a conta bloqueada: é como a empresa regulariza. */
@AllowWhenBlocked()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService, private readonly notices: BillingNoticeService, private readonly autopay: AutopayService) {}

  /** Teste grátis, taxa do mês, teto, prazo, bloqueio e faturas pendentes. */
  @Get('summary')
  async summary(@CurrentEnterprise() eid: string) {
    const [s, autopay] = await Promise.all([this.billing.getSummary(eid), this.autopay.status(eid)]);
    return { ...s, autopay, autopayAvailable: this.autopay.available };
  }

  /** Avisos da fatura: e-mail sempre; WhatsApp com o número e o "sim" do lojista. */
  @Get('notify')
  notify(@CurrentEnterprise() eid: string) { return this.notices.settings(eid); }

  @Put('notify')
  saveNotify(@CurrentEnterprise() eid: string, @Body() dto: NotifyDto) { return this.notices.save(eid, dto); }

  /** Cobrança automática no cartão: devolve o link do Mercado Pago, onde o lojista cadastra o cartão (o Balcão não vê o cartão). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('autopay')
  @HttpCode(200)
  startAutopay(@CurrentEnterprise() eid: string) { return this.autopay.start(eid); }

  /** Volta do Mercado Pago (ou "atualizar"): lê o estado da assinatura. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('autopay/sync')
  @HttpCode(200)
  syncAutopay(@CurrentEnterprise() eid: string) { return this.autopay.sync(eid); }

  @Delete('autopay')
  @HttpCode(200)
  cancelAutopay(@CurrentEnterprise() eid: string) { return this.autopay.cancel(eid); }

  /** Webhook das assinaturas (configure no painel do Mercado Pago os tópicos de assinatura com esta URL). */
  @Public()
  @SkipThrottle()
  @Post('webhook/mercadopago/assinatura')
  @HttpCode(200)
  autopayWebhook(@Query() q: Record<string, unknown>, @Body() body: Record<string, any> | undefined, @Headers('x-signature') signature?: string, @Headers('x-request-id') requestId?: string) {
    return this.autopay.webhook(q, body ?? {}, { signature, requestId });
  }

  @Get('invoices')
  invoices(@CurrentEnterprise() eid: string) {
    return this.billing.listInvoices(eid);
  }

  /** Fecha a taxa em aberto numa fatura agora (ex.: bateu os R$ 40 no meio do mês). */
  @Post('invoices')
  issueNow(@CurrentEnterprise() eid: string) {
    return this.billing.issueInvoiceNow(eid);
  }

  /** Gera/reaproveita o link de pagamento (Pix ou cartão) do Mercado Pago. Devolve `checkoutUrl`. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invoices/:id/pay')
  pay(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.billing.payInvoice(eid, id);
  }

  /** Ao voltar do checkout: confirma no Mercado Pago (usa o `payment_id` do redirecionamento). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invoices/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ConfirmDto) {
    return this.billing.confirmFromRedirect(eid, id, dto);
  }

  /** Webhook do Mercado Pago. Público e HTTPS; a URL leva um token por fatura (`?i=&s=`) e o pagamento é sempre consultado na API. */
  @Public()
  @SkipThrottle()
  @Post('webhook/mercadopago')
  @HttpCode(200)
  webhook(@Query() q: Record<string, unknown>, @Body() body: Record<string, unknown> | undefined, @Headers('x-signature') signature?: string, @Headers('x-request-id') requestId?: string) {
    return this.billing.handleMercadoPagoWebhook(q, body ?? {}, { signature, requestId });
  }
}
