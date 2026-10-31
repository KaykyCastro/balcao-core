import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Store, StoreSchemaFactory } from './schema/store.schema';
import { Order, OrderSchemaFactory } from './schema/order.schema';
import { StoreService } from './store.service';
import { OrderService } from './order.service';
import { MelhorEnvioClient } from './melhor-envio.client';
import { MercadoPagoClient } from './mercadopago.client';
import { StoreScheduler } from './store.scheduler';
import { OrderController, StoreConfigController } from './store.controller';
import { StorefrontController } from './storefront.controller';
import { EnterprisesModule } from '../enterprise/enterprise.module';
import { ProductModule } from '../products/product.module';
import { CategorysModule } from '../category/category.module';
import { PromotionModule } from '../promotion/promotion.module';
import { SaleModule } from '../sale/sale.module';
import { BillingModule } from '../billing/billing.module';
import { MailModule } from '../mail/mail.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Store.name, schema: StoreSchemaFactory },
      { name: Order.name, schema: OrderSchemaFactory },
    ]),
    EnterprisesModule, ProductModule, CategorysModule, PromotionModule, SaleModule, BillingModule, MailModule, SettingsModule,
  ],
  controllers: [StoreConfigController, OrderController, StorefrontController],
  providers: [StoreService, OrderService, MelhorEnvioClient, MercadoPagoClient, StoreScheduler],
})
export class StoreModule {}
