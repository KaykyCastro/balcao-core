import { CodeService } from './code/code.service';
import { DomainService } from './domain.service';
import { MessagesModule } from '../messages/messages.module';
import { MpOrdersWebhookService } from './mp-orders-webhook.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Store, StoreSchemaFactory } from './schema/store.schema';
import { Order, OrderSchemaFactory } from './schema/order.schema';
import { Tab, TabSchemaFactory } from './schema/tab.schema';
import { TabService } from './tab.service';
import { TabController, TabPublicController } from './tab.controller';
import { StoreService } from './store.service';
import { OrderService } from './order.service';
import { MelhorEnvioClient } from './melhor-envio.client';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { StoreScheduler } from './store.scheduler';
import { OrderController, StoreConfigController } from './store.controller';
import { StorefrontController } from './storefront.controller';
import { SeoController } from './seo.controller';
import { ShareController } from './share.controller';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { ProductEvent, ProductEventSchema } from './schema/product-event.schema';
import { MarketBanner, MarketBannerSchema } from './schema/market-banner.schema';
import { MarketBannerService } from './market-banner.service';
import { MarketBannerController } from './market-banner.controller';
import { Coupon, CouponSchema } from './schema/coupon.schema';
import { StoreCredit, StoreCreditSchema } from './schema/store-credit.schema';
import { RewardsService } from './rewards.service';
import { CouponController } from './coupon.controller';
import { Review, ReviewSchema } from './schema/review.schema';
import { ReviewService } from './review.service';
import { MerchantReviewController, PublicReviewController } from './review.controller';
import { SoldCountScheduler } from './sold-count.scheduler';
import { EnterprisesModule } from '../enterprise/enterprise.module';
import { ProductModule } from '../products/product.module';
import { CategorysModule } from '../category/category.module';
import { PromotionModule } from '../promotion/promotion.module';
import { SaleModule } from '../sale/sale.module';
import { BillingModule } from '../billing/billing.module';
import { MailModule } from '../mail/mail.module';
import { SettingsModule } from '../settings/settings.module';
import { CustomerModule } from '../customer/customer.module';
import { ShopperModule } from '../shopper/shopper.module';
import { ShopperAccountController } from './shopper-account.controller';
import { MediaService } from './media.service';
import { EmailCodeService } from './email-code.service';
import { ProtectionService } from './protection.service';
import { LogisticsService } from './logistics.service';
import { MediaController } from './media.controller';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProductEvent.name, schema: ProductEventSchema },
      { name: MarketBanner.name, schema: MarketBannerSchema },
      { name: Coupon.name, schema: CouponSchema },
      { name: StoreCredit.name, schema: StoreCreditSchema },
      { name: Review.name, schema: ReviewSchema },
      { name: Store.name, schema: StoreSchemaFactory },
      { name: Order.name, schema: OrderSchemaFactory },
      { name: Tab.name, schema: TabSchemaFactory },
    ]),
    MessagesModule, EnterprisesModule, ProductModule, CategorysModule, PromotionModule, SaleModule, BillingModule, MailModule, SettingsModule, MercadoPagoModule, CustomerModule, ShopperModule, StaffModule,
  ],
  controllers: [StoreConfigController, MediaController, OrderController, SeoController, ShareController, MarketplaceController, MarketBannerController, CouponController, PublicReviewController, MerchantReviewController, StorefrontController, ShopperAccountController, TabController, TabPublicController],
  providers: [DomainService, MpOrdersWebhookService, CodeService, MarketplaceService, MarketBannerService, RewardsService, ReviewService, SoldCountScheduler, StoreService, OrderService, MelhorEnvioClient, StoreScheduler, MediaService, EmailCodeService, ProtectionService, LogisticsService, TabService],
  exports: [StoreService, OrderService, ProtectionService, TabService, MarketBannerService],
})
export class StoreModule {}
