import { Controller, Body, Post, Get, Param, Put, Delete, Query, HttpCode } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { ProductService } from './product.service';
import { PromotionService } from '../promotion/promotion.service';
import { ProductCreateDto } from './dto/product-create.dto';
import { ProductUpdateDto } from './dto/product-update.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';

class ProductListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsMongoId()
  categoryId?: string;
}

class LowStockQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000)
  threshold: number = 5;
}

@Controller('product')
export class ProductController {
  constructor(private readonly productService: ProductService, private readonly promotions: PromotionService) {}

  /** Cada produto sai com `promotion` (ou null): a tela de vendas mostra o preço promocional e as unidades que restam. */
  private async one(eid: string, p: Parameters<PromotionService['decorate']>[1][number]) {
    return (await this.promotions.decorate(eid, [p]))[0];
  }

  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: ProductCreateDto) {
    return this.productService.create(eid, dto);
  }

  @Get()
  async list(@CurrentEnterprise() eid: string, @Query() q: ProductListQueryDto) {
    const page = await this.productService.list(eid, q);
    return { ...page, items: await this.promotions.decorate(eid, page.items) };
  }

  /** Produtos com estoque baixo (só os que controlam estoque). `?threshold=5` */
  @Get('low-stock')
  lowStock(@CurrentEnterprise() eid: string, @Query() q: LowStockQueryDto) {
    return this.productService.lowStock(eid, q.threshold);
  }

  /** Busca exata por código de barras (leitor do PDV). 404 se não existir. */
  @Get('by-code/:code')
  async byCode(@CurrentEnterprise() eid: string, @Param('code') code: string) {
    return this.one(eid, await this.productService.findByCode(eid, code.slice(0, 64)));
  }

  @Get(':id')
  async getById(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.one(eid, (await this.productService.getFull(eid, id)) as never);
  }

  @Put(':id')
  update(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ProductUpdateDto) {
    return this.productService.update(eid, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.productService.delete(eid, id);
  }
}
