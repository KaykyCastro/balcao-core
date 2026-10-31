import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { PromotionController } from './promotion.controller';
import { PromotionService } from './promotion.service';
import { Promotion, PromotionSchemaFactory } from './schema/promotion.schema';

@Module({
  imports: [MongooseModule.forFeature([
    { name: Promotion.name, schema: PromotionSchemaFactory },
    { name: ProductSchema.name, schema: ProductSchemaFactory },
  ])],
  controllers: [PromotionController],
  providers: [PromotionService],
  exports: [PromotionService],
})
export class PromotionModule {}
