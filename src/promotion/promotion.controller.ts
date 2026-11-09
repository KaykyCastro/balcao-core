import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { PromotionCreateDto, PromotionGroupCreateDto, PromotionGroupUpdateDto, PromotionListQueryDto, PromotionUpdateDto } from './dto/promotion.dto';
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

  /** Promoção com vários produtos, cada um com seu desconto e limite (ex.: 10 do X e 2 do Y). */
  @Post('group')
  createGroup(@CurrentEnterprise() eid: string, @Body() dto: PromotionGroupCreateDto) { return this.promotions.createGroup(eid, dto); }

  @Patch('group/:groupId')
  updateGroup(@CurrentEnterprise() eid: string, @Param('groupId', ParseMongoIdPipe) gid: string, @Body() dto: PromotionGroupUpdateDto) { return this.promotions.updateGroup(eid, gid, dto); }

  @Post('group/:groupId/end')
  endGroup(@CurrentEnterprise() eid: string, @Param('groupId', ParseMongoIdPipe) gid: string) { return this.promotions.endGroup(eid, gid); }

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
