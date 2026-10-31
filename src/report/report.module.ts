import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { CustomerSchema, CustomerSchemaFactory } from '../customer/schema/customer.schema';
import { PromotionModule } from '../promotion/promotion.module';

@Module({
  imports: [PromotionModule, MongooseModule.forFeature([
    { name: Sale.name, schema: SaleSchemaFactory },
    { name: ProductSchema.name, schema: ProductSchemaFactory },
    { name: CustomerSchema.name, schema: CustomerSchemaFactory },
  ])],
  controllers: [ReportController],
  providers: [ReportService],
})
export class ReportModule {}
