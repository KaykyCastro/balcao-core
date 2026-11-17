import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { CustomerSchema, CustomerSchemaFactory } from '../customer/schema/customer.schema';
import { PromotionModule } from '../promotion/promotion.module';
import { CustomerPayment, CustomerPaymentSchemaFactory } from '../customer/schema/customer-payment.schema';
import { CashClosing, CashClosingSchemaFactory } from './schema/cash-closing.schema';
import { Exchange, ExchangeSchema } from '../exchange/schema/exchange.schema';
import { CashCloseController } from './cash-close.controller';
import { CashCloseService } from './cash-close.service';

@Module({
  imports: [PromotionModule, MongooseModule.forFeature([
    { name: Sale.name, schema: SaleSchemaFactory },
    { name: ProductSchema.name, schema: ProductSchemaFactory },
    { name: CustomerSchema.name, schema: CustomerSchemaFactory },
    { name: CustomerPayment.name, schema: CustomerPaymentSchemaFactory },
    { name: CashClosing.name, schema: CashClosingSchemaFactory },
    { name: Exchange.name, schema: ExchangeSchema },
  ])],
  controllers: [ReportController, CashCloseController],
  providers: [ReportService, CashCloseService],
})
export class ReportModule {}
