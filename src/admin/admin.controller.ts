import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminService } from './admin.service';
import { AuditQuery, EnterpriseListQuery, ExtendInvoiceDto, InvoiceListQuery, InvoiceNoteDto, UnblockDto, UpdateEnterpriseDto, UpdateSettingsDto } from './admin.dto';
import { SendMessageDto, SentQuery } from '../messages/messages.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';

type Req = { user: { _id: unknown; email: string } };
const actor = (req: Req) => ({ id: String(req.user._id), email: req.user.email });

/** Painel do dono do ERP. O papel 'admin' é conferido no banco a cada request (RolesGuard). */
@Roles('admin')
@AllowWhenBlocked()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** Empresas, vendas, faturamento da taxa, inadimplência e ranking. */
  @Get('metrics')
  metrics() { return this.admin.metrics(); }

  /** `?search=&status=active|trial|blocked|suspended&page=&limit=` */
  @Get('enterprises')
  list(@Query() q: EnterpriseListQuery) { return this.admin.listEnterprises(q); }

  @Get('enterprises/:id')
  one(@Param('id', ParseMongoIdPipe) id: string) { return this.admin.getEnterprise(id); }

  /** Suspender/reativar, isentar da taxa, estender o teste grátis. */
  @Patch('enterprises/:id')
  update(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: UpdateEnterpriseDto) {
    return this.admin.updateEnterprise(actor(req), id, dto);
  }

  /** Desbloqueia uma conta com fatura vencida, dando mais prazo. */
  @Post('enterprises/:id/unblock') @HttpCode(200)
  unblock(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: UnblockDto) {
    return this.admin.unblock(actor(req), id, dto.extendDays);
  }

  @Get('invoices')
  invoices(@Query() q: InvoiceListQuery) { return this.admin.listInvoices(q); }

  /** Baixa manual (pagou por fora). Abate a dívida e desbloqueia se não houver outra vencida. */
  @Post('invoices/:id/mark-paid') @HttpCode(200)
  markPaid(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: InvoiceNoteDto) {
    return this.admin.markInvoicePaid(actor(req), id, dto.note);
  }

  /** Perdoa a fatura. */
  @Post('invoices/:id/cancel') @HttpCode(200)
  cancel(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: InvoiceNoteDto) {
    return this.admin.cancelInvoice(actor(req), id, dto.note);
  }

  @Post('invoices/:id/extend') @HttpCode(200)
  extend(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ExtendInvoiceDto) {
    return this.admin.extendInvoice(actor(req), id, dto.days, dto.note);
  }

  /** Roda o fechamento mensal/bloqueios agora (é idempotente). */
  @Post('billing/run-close') @HttpCode(200)
  runClose(@Req() req: Req) { return this.admin.runClose(actor(req)); }

  /** Política da plataforma: teto mensal da taxa (centavos) e dias de teste grátis dos novos cadastros. */
  @Get('settings')
  settings() { return this.admin.getSettings(); }

  @Put('settings')
  updateSettings(@Req() req: Req, @Body() dto: UpdateSettingsDto) { return this.admin.updateSettings(actor(req), dto); }

  /** Envia aviso a uma empresa (`enterpriseId`) ou a todas as ativas (sem `enterpriseId`). */
  @Post('messages') @HttpCode(201)
  sendMessage(@Req() req: Req, @Body() dto: SendMessageDto) { return this.admin.sendMessage(actor(req), dto); }

  @Get('messages')
  messages(@Query() q: SentQuery) { return this.admin.listMessages(q); }

  /** Recolhe um envio (some da caixa de entrada das empresas). */
  @Delete('messages/:id') @HttpCode(200)
  recall(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string) { return this.admin.recallMessage(actor(req), id); }

  @Get('audit')
  audit(@Query() q: AuditQuery) { return this.admin.listAudit(q); }
}
