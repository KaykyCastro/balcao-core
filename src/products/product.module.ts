import { Module } from '@nestjs/common';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductSchema, ProductSchemaFactory } from './schema/product.schema';
import { CategorysModule } from '../category/category.module';
import { PromotionModule } from '../promotion/promotion.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ProductSchema.name, schema: ProductSchemaFactory }]),
    CategorysModule,
    PromotionModule,
  ],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
