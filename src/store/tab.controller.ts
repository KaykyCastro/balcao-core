import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { PrintQueueDto } from './dto/order.dto';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { TabService } from './tab.service';
import { TabByDto, TabCallDto, TabCancelDto, TabCancelItemDto, TabLinesDto, TabLinesPublicDto, TabMoveDto, TabOpenDto, TabOpenPublicDto, TabRenameDto, TabServeDto, TabServiceDto, TabSettleDto, TabTokenDto, TabPrintClaimDto } from './dto/tab.dto';

type Rq = { user?: { email?: string; staff?: { id: string; name: string; role: string } } };
/** Nome no histórico: o funcionário logado; o dono pode digitar o nome do garçom. */
const who = (req: Rq, by?: string) => req.user?.staff?.name || by?.trim() || req.user?.email || 'equipe';
const st = (req: Rq) => (req.user?.staff ? { id: req.user.staff.id, name: req.user.staff.name, role: req.user.staff.role } : null);

/** Painel: mesas e comandas (garçom e caixa). */
@Controller('tabs')
export class TabController {
  constructor(private readonly tabs: TabService) {}

  @AllowWhenBlocked() @Get() board(@CurrentEnterprise() eid: string) { return this.tabs.board(eid); }
  @AllowWhenBlocked() @Get('summary') summary(@CurrentEnterprise() eid: string) { return this.tabs.summary(eid); }
  /** Impressão automática na cozinha: itens novos das contas, e a reserva de quem vai imprimir. */
  @AllowWhenBlocked() @Get('print-queue') printQueue(@CurrentEnterprise() eid: string, @Query() q: PrintQueueDto) { return this.tabs.printQueue(eid, new Date(q.since)); }
  @AllowWhenBlocked() @Post(':id/print-claim') @HttpCode(200) claimPrint(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabPrintClaimDto) { return this.tabs.claimPrint(eid, id, dto.ids); }
  @Post() open(@CurrentEnterprise() eid: string, @Body() dto: TabOpenDto, @Req() req: Rq) { return this.tabs.openStaff(eid, dto, st(req)); }
  @Post(':id/items') @HttpCode(200) add(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabLinesDto, @Req() req: Rq) { return this.tabs.staffAdd(eid, id, dto.items, st(req)); }
  @AllowWhenBlocked() @Post(':id/serve') @HttpCode(200) serve(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabServeDto, @Req() req: Rq) { return this.tabs.serve(eid, id, dto.itemIds, st(req)); }
  @AllowWhenBlocked() @Post(':id/items/:item/cancel') @HttpCode(200)
  cancelItem(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Param('item', ParseMongoIdPipe) item: string, @Body() dto: TabCancelItemDto) { return this.tabs.cancelItem(eid, id, item, dto.reason ?? ''); }
  @AllowWhenBlocked() @Post(':id/ack') @HttpCode(200) ack(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Req() req: Rq) { return this.tabs.ackCall(eid, id, st(req)); }
  /** Garçom assume a conta (recebe os chamados dela). */
  @AllowWhenBlocked() @Post(':id/claim') @HttpCode(200) claim(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Req() req: Rq) { return this.tabs.assign(eid, id, st(req)); }
  /** Libera o pagamento: o cliente pode pagar pelo celular (ou o garçom cobra na mesa). */
  @AllowWhenBlocked() @Post(':id/release') @HttpCode(200) release(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabByDto, @Req() req: Rq) { return this.tabs.release(eid, id, who(req, dto.by), st(req)); }
  @AllowWhenBlocked() @Post(':id/reopen') @HttpCode(200) reopen(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.tabs.reopen(eid, id); }
  /** Recebido no local (dinheiro, Pix, maquininha avulsa): fecha a conta e gera a venda. */
  @AllowWhenBlocked() @Post(':id/settle') @HttpCode(200) settle(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabSettleDto, @Req() req: Rq) { return this.tabs.settle(eid, id, dto, who(req, dto.by), st(req)); }
  @AllowWhenBlocked() @Post(':id/service') @HttpCode(200) service(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabServiceDto) { return this.tabs.setService(eid, id, dto.on); }
  @AllowWhenBlocked() @Post(':id/move') @HttpCode(200) move(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabMoveDto) { return this.tabs.move(eid, id, dto.table); }
  @AllowWhenBlocked() @Post(':id/rename') @HttpCode(200) rename(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabRenameDto) { return this.tabs.rename(eid, id, dto.name); }
  @AllowWhenBlocked() @Post(':id/cancel') @HttpCode(200) cancel(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabCancelDto) { return this.tabs.cancel(eid, id, dto.reason); }
}

/** Cliente na mesa (QR Code): abre a conta, pede, chama o garçom e paga quando liberado. */
@Public()
@Controller('public')
export class TabPublicController {
  constructor(private readonly tabs: TabService) {}

  @Throttle({ default: { limit: 6, ttl: 10 * 60_000 } })
  @Post('store/:slug/tabs') open(@Param('slug') slug: string, @Body() dto: TabOpenPublicDto) { return this.tabs.openPublic(slug, dto); }

  @Get('store/:slug/tabs/:id')
  view(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Query('t') t: string, @Query('payment_id') paymentId?: string) {
    return this.tabs.publicView(slug, id, String(t ?? '').slice(0, 200), paymentId ? String(paymentId).slice(0, 44) : undefined);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('store/:slug/tabs/:id/items') @HttpCode(200)
  add(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabLinesPublicDto) { return this.tabs.customerAdd(slug, id, dto.t, dto.items); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('store/:slug/tabs/:id/call') @HttpCode(200)
  call(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabCallDto) { return this.tabs.call(slug, id, dto.t, dto.kind, dto.pay, dto.changeForCents); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('store/:slug/tabs/:id/pay') @HttpCode(200)
  pay(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TabTokenDto) { return this.tabs.pay(slug, id, dto.t); }

  @SkipThrottle()
  @Post('tab-webhook/mercadopago') @HttpCode(200)
  webhook(@Query() q: Record<string, unknown>, @Body() body: Record<string, unknown> | undefined, @Headers('x-signature') signature?: string, @Headers('x-request-id') requestId?: string) {
    return this.tabs.webhook(q, body ?? {}, { signature, requestId });
  }
}
