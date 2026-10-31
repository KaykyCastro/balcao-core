import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SaleService } from './sale.service';
import { SaleController } from './sale.controller';
import { Sale, SaleSchemaFactory } from './schema/sale.schema';
import { ProductModule } from '../products/product.module';
import { CustomerModule } from '../customer/customer.module';
import { BillingModule } from '../billing/billing.module';
import { PromotionModule } from '../promotion/promotion.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Sale.name, schema: SaleSchemaFactory }]),
    ProductModule,
    CustomerModule,
    BillingModule,
    PromotionModule,
  ],
  controllers: [SaleController],
  providers: [SaleService],
  exports: [SaleService],
})
export class SaleModule {}
