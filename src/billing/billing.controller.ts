import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsString, Matches, MaxLength } from 'class-validator';
import { BillingService } from './billing.service';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';

class ConfirmDto {
  @IsString() @MaxLength(200) @Matches(/^[\w.-]+$/)
  transactionNsu: string;

  @IsString() @MaxLength(200) @Matches(/^[\w.-]+$/)
  slug: string;
}

/** Tudo aqui continua acessível com a conta bloqueada: é como a empresa regulariza. */
@AllowWhenBlocked()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Teste grátis, taxa do mês, teto, prazo, bloqueio e faturas pendentes. */
  @Get('summary')
  summary(@CurrentEnterprise() eid: string) {
    return this.billing.getSummary(eid);
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

  /** Gera/reaproveita o link de pagamento (Pix ou cartão) da InfinitePay. Devolve `checkoutUrl`. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invoices/:id/pay')
  pay(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.billing.payInvoice(eid, id);
  }

  /** Ao voltar do checkout: confirma na InfinitePay (usa os parâmetros `transaction_nsu` e `slug` do redirecionamento). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invoices/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ConfirmDto) {
    return this.billing.confirmFromRedirect(eid, id, dto);
  }

  /** Webhook da InfinitePay. Público e HTTPS; a URL leva um token por fatura (`?s=`) e tudo é reconfirmado no payment_check. */
  @Public()
  @SkipThrottle()
  @Post('webhook/infinitepay')
  @HttpCode(200)
  webhook(@Query('s') token: string | undefined, @Body() body: Record<string, unknown> | undefined) {
    return this.billing.handleInfinitePayWebhook({ token, body: body ?? {} });
  }
}
