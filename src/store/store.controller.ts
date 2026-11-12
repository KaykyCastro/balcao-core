import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Delete } from '@nestjs/common';
import { DomainService } from './domain.service';
import { Throttle } from '@nestjs/throttler';
import { StoreService } from './store.service';
import { OrderService } from './order.service';
import { MpCallbackDto, SlugQueryDto, StoreUpdateDto, TestQuoteDto, VisibilityDto, StorePageDto, StoreDomainDto } from './dto/store.dto';
import { CollectDto, LabelDto, LabelsPrintDto, OrderCancelDto, OrderListQueryDto, OrderStatusDto, ReplyDto, PrintQueueDto } from './dto/order.dto';
import { LogisticsService } from './logistics.service';
import { ProtectionService } from './protection.service';
import { TabService } from './tab.service';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { ProductService } from '../products/product.service';
import { CodeService } from './code/code.service';
import { CodeCompileDto } from './dto/store.dto';

/** Painel do lojista: configuração da loja online. */
@Controller('store-config')
export class StoreConfigController {
  constructor(private readonly stores: StoreService, private readonly products: ProductService, private readonly code: CodeService, private readonly domains: DomainService) {}

  @Get()
  get(@CurrentEnterprise() eid: string) {
    return this.stores.view(eid);
  }

  /** Taxas da loja online (para o botão "preço com a taxa" do cadastro de produto; liberado a quem cuida do estoque). */
  /** Domínio próprio: situação e os registros de DNS a criar. */
  @Get('domain')
  domain(@CurrentEnterprise() eid: string) { return this.domains.info(eid); }

  @Put('domain')
  setDomain(@CurrentEnterprise() eid: string, @Body() dto: StoreDomainDto) { return this.domains.set(eid, dto.host); }

  /** Confere o DNS agora (aponta para o Balcão + código de confirmação). */
  @Post('domain/verify')
  @HttpCode(200)
  verifyDomain(@CurrentEnterprise() eid: string) { return this.domains.verify(eid); }

  @Delete('domain')
  removeDomain(@CurrentEnterprise() eid: string) { return this.domains.remove(eid); }

  @Get('fees')
  fees(@CurrentEnterprise() eid: string) {
    return this.stores.fees(eid);
  }

  @Put()
  update(@CurrentEnterprise() eid: string, @Body() dto: StoreUpdateDto) {
    return this.stores.update(eid, dto);
  }

  /** Construtor de sites: rascunho ou publicar (só o dono). */
  @Put('page')
  savePage(@CurrentEnterprise() eid: string, @Body() dto: StorePageDto) {
    return this.stores.savePage(eid, dto.page, dto.publish === true);
  }

  /** Componente Código: prévia no construtor (a árvore e o CSS salvos são sempre gerados de novo no savePage). */
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @Post('code/compile')
  @HttpCode(200)
  compileCode(@Body() dto: CodeCompileDto) {
    return this.code.compile(dto.code);
  }

  /** Mercado Pago: link para o lojista autorizar a conta dele (OAuth). */
  @Get('mercadopago/connect')
  mpConnect(@CurrentEnterprise() eid: string) {
    return this.stores.mpConnectUrl(eid);
  }

  /** Volta do Mercado Pago: o painel envia `code` e `state` recebidos na URL. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mercadopago/callback')
  @HttpCode(200)
  mpCallback(@CurrentEnterprise() eid: string, @Body() dto: MpCallbackDto) {
    return this.stores.mpCallback(eid, dto.code, dto.state);
  }

  @Post('mercadopago/disconnect')
  @HttpCode(200)
  mpDisconnect(@CurrentEnterprise() eid: string) {
    return this.stores.mpDisconnect(eid);
  }

  /** Link de prévia: o lojista vê a loja como o cliente, mesmo desligada e sem pagamento/entrega. */
  @Get('preview')
  preview(@CurrentEnterprise() eid: string) {
    return this.stores.previewLink(eid);
  }

  @Get('slug-available')
  slug(@CurrentEnterprise() eid: string, @Query() q: SlugQueryDto) {
    return this.stores.slugAvailable(eid, q.slug);
  }

  /** Publica/esconde produtos na loja (vários de uma vez, ou todos). */
  @Post('products/visibility')
  @HttpCode(200)
  async visibility(@CurrentEnterprise() eid: string, @Body() dto: VisibilityDto) {
    const changed = await this.products.setShowOnline(eid, dto.all ? 'all' : dto.ids ?? [], dto.show);
    return { changed };
  }

  /** Simula o frete de um produto padrão até um CEP, para o lojista conferir a configuração. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('shipping/test')
  @HttpCode(200)
  async testQuote(@CurrentEnterprise() eid: string, @Body() dto: TestQuoteDto) {
    const store = await this.stores.getOrCreate(eid);
    const options = await this.stores.quote(store, dto.cep, [{ productId: 'teste', name: 'Produto de teste', quantity: 1, unitCents: 10_000, dims: {} }]);
    return { options };
  }
}

/** Painel do lojista: pedidos da loja online. */
@Controller('orders')
export class OrderController {
  constructor(private readonly orders: OrderService, private readonly protection: ProtectionService, private readonly logistics: LogisticsService, private readonly tabs: TabService) {}

  @Get()
  list(@CurrentEnterprise() eid: string, @Query() q: OrderListQueryDto) {
    return this.orders.list(eid, q);
  }

  @Get('summary')
  async summary(@CurrentEnterprise() eid: string) {
    // Mesas (modo cardápio): chamados de garçom e itens novos entram no aviso do menu.
    const [o, tables] = await Promise.all([this.orders.summary(eid), this.tabs.summary(eid)]);
    return { ...o, tables };
  }

  /** Impressão automática (cada computador que ligou a opção): pedidos novos ainda não impressos. */
  @Get('print-queue')
  printQueue(@CurrentEnterprise() eid: string, @Query() q: PrintQueueDto) {
    return this.orders.printQueue(eid, new Date(q.since));
  }

  /** Reserva o pedido para este computador imprimir (os outros computadores pulam). */
  @Post(':id/print-claim')
  @HttpCode(200)
  claimPrint(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.orders.claimPrint(eid, id);
  }

  /** PDF com as etiquetas dos pedidos escolhidos (Melhor Envio). */
  @Post('labels/print')
  @HttpCode(200)
  printLabels(@CurrentEnterprise() eid: string, @Body() dto: LabelsPrintDto) {
    return this.logistics.print(eid, dto.ids);
  }

  @Get(':id')
  get(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.orders.get(eid, id);
  }

  @Post(':id/status')
  @HttpCode(200)
  status(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: OrderStatusDto) {
    return this.orders.setStatus(eid, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: OrderCancelDto) {
    return this.orders.cancel(eid, id, dto);
  }

  /** Compra protegida: responde a reclamação do cliente. */
  @Post(':id/dispute/reply')
  @HttpCode(200)
  reply(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ReplyDto) {
    return this.protection.reply(eid, id, dto.message);
  }

  /** Compra a etiqueta no Melhor Envio (debita a carteira do lojista) e já deixa pronta para imprimir. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/label')
  @HttpCode(200)
  label(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: LabelDto) {
    return this.logistics.buyLabel(eid, id, dto);
  }

  @Post(':id/label/cancel')
  @HttpCode(200)
  cancelLabel(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.logistics.cancel(eid, id);
  }

  /** Pago na entrega/retirada: registra como foi pago e marca como entregue. */
  @Post(':id/collect')
  @HttpCode(200)
  collect(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: CollectDto) {
    return this.orders.collect(eid, id, dto);
  }

  /** Devolve o dinheiro (também depois de entregue: desistência ou defeito). */
  @Post(':id/refund')
  @HttpCode(200)
  refund(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: OrderCancelDto) {
    return this.protection.refundBySeller(eid, id, dto.reason.trim());
  }
}
