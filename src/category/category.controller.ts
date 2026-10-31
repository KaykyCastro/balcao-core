import { Body, Controller, Post, Get, Delete, Put, Param, HttpCode } from '@nestjs/common';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { CategoryService } from './category.service';
import { CategoryCreateDto } from './dto/category-create.dto';
import { CategoryUpdateDto } from './dto/category-update.dto';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';

@Controller('category')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: CategoryCreateDto) {
    return this.categoryService.create(eid, dto);
  }

  @Get()
  list(@CurrentEnterprise() eid: string) {
    return this.categoryService.list(eid);
  }

  @Get(':id')
  findById(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.categoryService.findCategoryById(eid, id);
  }

  @Put(':id')
  update(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: CategoryUpdateDto) {
    return this.categoryService.update(eid, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.categoryService.delete(eid, id);
  }
}
