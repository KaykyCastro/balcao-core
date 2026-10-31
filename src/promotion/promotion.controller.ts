import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { PromotionCreateDto, PromotionListQueryDto, PromotionUpdateDto } from './dto/promotion.dto';
import { PromotionService } from './promotion.service';

@Controller('promotion')
export class PromotionController {
  constructor(private readonly promotions: PromotionService) {}

  /** `?filter=open|closed|all&search=&productId=&page=&limit=` */
  @Get()
  list(@CurrentEnterprise() eid: string, @Query() q: PromotionListQueryDto) {
    return this.promotions.list(eid, q);
  }

  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: PromotionCreateDto) {
    return this.promotions.create(eid, dto);
  }

  @Patch(':id')
  update(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: PromotionUpdateDto) {
    return this.promotions.update(eid, id, dto);
  }

  /** Encerra antes do fim: o produto volta ao preço normal na hora. */
  @Post(':id/end')
  end(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.promotions.end(eid, id);
  }
}
