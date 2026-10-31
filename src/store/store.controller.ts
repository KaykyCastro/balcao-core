import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StoreService } from './store.service';
import { OrderService } from './order.service';
import { MpCallbackDto, SlugQueryDto, StoreUpdateDto, TestQuoteDto, VisibilityDto } from './dto/store.dto';
import { OrderCancelDto, OrderListQueryDto, OrderStatusDto } from './dto/order.dto';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { ProductService } from '../products/product.service';

/** Painel do lojista: configuração da loja online. */
@Controller('store-config')
export class StoreConfigController {
  constructor(private readonly stores: StoreService, private readonly products: ProductService) {}

  @Get()
  get(@CurrentEnterprise() eid: string) {
    return this.stores.view(eid);
  }

  @Put()
  update(@CurrentEnterprise() eid: string, @Body() dto: StoreUpdateDto) {
    return this.stores.update(eid, dto);
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
  constructor(private readonly orders: OrderService) {}

  @Get()
  list(@CurrentEnterprise() eid: string, @Query() q: OrderListQueryDto) {
    return this.orders.list(eid, q);
  }

  @Get('summary')
  summary(@CurrentEnterprise() eid: string) {
    return this.orders.summary(eid);
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
}
