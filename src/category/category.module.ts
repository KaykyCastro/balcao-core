import { Module } from '@nestjs/common';
import { CategoryService } from './category.service';
import { CategoryController } from './category.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { CategorySchema, CategorySchemaFactory } from './schema/category.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: CategorySchema.name, schema: CategorySchemaFactory }])],
  controllers: [CategoryController],
  providers: [CategoryService],
  exports: [CategoryService],
})
export class CategorysModule {}
