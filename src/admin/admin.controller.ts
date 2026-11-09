import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminService } from './admin.service';
import { AuditQuery, BlockStoreDto, DisputeListQuery, ResolveDisputeDto, EnterpriseListQuery, ExtendInvoiceDto, FreeMonthDto, InvoiceListQuery, ReduceInvoiceDto, InvoiceNoteDto, PrivacyRequestDto, ShopperListQuery, StoreListQuery, UnblockDto, UnblockStoreDto, UpdateEnterpriseDto, UpdateSettingsDto } from './admin.dto';
import { AdminTrustService } from './admin-trust.service';
import { MarketBannerService } from '../store/market-banner.service';
import { MarketBannerDto, MarketBannerPatchDto } from '../store/dto/market-banner.dto';
import { ArrayMaxSize, IsArray, IsIn, IsMongoId } from 'class-validator';

class ReorderBannersDto {
  @IsIn(['hero', 'middle']) placement: 'hero' | 'middle';
  @IsArray() @ArrayMaxSize(20) @IsMongoId({ each: true }) ids: string[];
}
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
  constructor(private readonly admin: AdminService, private readonly trust: AdminTrustService, private readonly banners: MarketBannerService) {}

  /** Carrosséis do marketplace "Lojas no Balcão": promoções (topo) e anúncios do Balcão (meio). */
  @Get('market-banners')
  listBanners() { return this.banners.adminList(); }

  @Post('market-banners')
  async createBanner(@Req() req: Req, @Body() dto: MarketBannerDto) {
    const b = await this.banners.create(dto);
    await this.admin.record(actor(req), 'banner.create', { id: b.id, title: b.title, placement: b.placement });
    return b;
  }

  @Post('market-banners/reorder') @HttpCode(200)
  async reorderBanners(@Req() req: Req, @Body() dto: ReorderBannersDto) {
    await this.banners.reorder(dto.placement, dto.ids);
    await this.admin.record(actor(req), 'banner.reorder', { placement: dto.placement });
    return { ok: true };
  }

  @Patch('market-banners/:id')
  async updateBanner(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: MarketBannerPatchDto) {
    const b = await this.banners.update(id, dto);
    await this.admin.record(actor(req), 'banner.update', { id, title: b.title, fields: Object.keys(dto).filter((k) => k !== 'image') });
    return b;
  }

  @Delete('market-banners/:id')
  async deleteBanner(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string) {
    await this.banners.remove(id);
    await this.admin.record(actor(req), 'banner.delete', { id });
    return { ok: true };
  }

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

  /** Desconto numa fatura pendente (motivo obrigatório; vai para a auditoria). */
  @Post('invoices/:id/reduce') @HttpCode(200)
  reduce(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ReduceInvoiceDto) {
    return this.admin.reduceInvoice(actor(req), id, dto.amountCents, dto.note);
  }

  /** Mês grátis escolhendo o mês (AAAA-MM). */
  @Post('enterprises/:id/free-month') @HttpCode(200)
  freeMonth(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: FreeMonthDto) {
    return this.admin.grantFreeMonth(actor(req), id, dto.period, dto.note);
  }
  @Post('enterprises/:id/free-month/revoke') @HttpCode(200)
  revokeFreeMonth(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: FreeMonthDto) {
    return this.admin.revokeFreeMonth(actor(req), id, dto.period);
  }

  /** Visão de tudo: lojistas, colaboradores, clientes dos lojistas, produtos e marketplace (números agregados). */
  @Get('overview')
  overview() { return this.admin.overview(); }

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

  // ---------------------------------------------------------------- lojas online

  /** `?search=&status=online|offline|paused|blocked|no_legal` */
  @Get('stores')
  stores(@Query() q: StoreListQuery) { return this.trust.listStores(q); }

  @Get('stores/:id')
  store(@Param('id', ParseMongoIdPipe) id: string) { return this.trust.getStore(id); }

  /** Tira a loja do ar (denúncia, dados falsos, regras). O lojista não consegue religar até ser liberada. */
  @Post('stores/:id/block') @HttpCode(200)
  blockStore(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: BlockStoreDto) {
    return this.trust.blockStore(actor(req), id, dto.reason, dto.notify !== false);
  }

  /** Retira a suspensão. A loja continua desligada até o lojista religar. */
  @Post('stores/:id/unblock') @HttpCode(200)
  unblockStore(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: UnblockStoreDto) {
    return this.trust.unblockStore(actor(req), id, dto.note, dto.notify !== false);
  }

  // ---------------------------------------------------------------- reclamações (Compra protegida)

  @Get('disputes')
  disputes(@Query() q: DisputeListQuery) { return this.trust.listDisputes({ status: q.status, page: q.page, limit: q.limit }); }

  /** Decide a reclamação: devolve o dinheiro ao cliente ou encerra a favor da loja. */
  @Post('disputes/:id/resolve') @HttpCode(200)
  resolveDispute(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ResolveDisputeDto) {
    return this.trust.resolveDispute(actor(req), id, dto.decision, dto.note.trim());
  }

  // ---------------------------------------------------------------- LGPD e documentos

  /** Aceites dos documentos, lojas sem dados do vendedor e pedidos de titulares. */
  @Get('compliance')
  compliance() { return this.trust.compliance(); }

  /** Avisa os lojistas que ainda não aceitaram a versão atual dos Termos e da Política de Privacidade. */
  @Post('compliance/remind') @HttpCode(200)
  remind(@Req() req: Req) { return this.trust.remindOutdated(actor(req)); }

  @Get('shoppers')
  shoppers(@Query() q: ShopperListQuery) { return this.trust.listShoppers(q); }

  /** Cópia dos dados de um comprador, para responder a pedido do titular recebido por e-mail. Fica na auditoria. */
  @Post('shoppers/:id/export') @HttpCode(200)
  exportShopper(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: PrivacyRequestDto) {
    return this.trust.exportShopper(actor(req), id, dto.reason);
  }

  /** Exclui a conta de um comprador a pedido do titular. Pedidos ficam com as lojas, sem vínculo com a conta. */
  @Post('shoppers/:id/delete') @HttpCode(200)
  deleteShopper(@Req() req: Req, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: PrivacyRequestDto) {
    return this.trust.deleteShopper(actor(req), id, dto.reason);
  }
}
