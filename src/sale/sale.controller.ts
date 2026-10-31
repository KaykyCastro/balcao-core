import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsMongoId, IsOptional } from 'class-validator';
import { SaleService } from './sale.service';
import { SaleCreateDto } from './dto/sale-create.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';

class SaleListQueryDto extends PaginationQueryDto {
  @IsOptional() @IsMongoId()
  customerId?: string;

  @IsOptional() @IsIn(['completed', 'cancelled'])
  status?: 'completed' | 'cancelled';
}

@Controller('sale')
export class SaleController {
  constructor(private readonly saleService: SaleService) {}

  /** Envie `Idempotency-Key` (8 a 64 caracteres) para poder repetir o pedido sem vender duas vezes. */
  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: SaleCreateDto, @Headers('idempotency-key') key?: string) {
    if (key !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new BadRequestException('Idempotency-Key inválida');
    return this.saleService.create(eid, dto, key);
  }

  @Get()
  list(@CurrentEnterprise() eid: string, @Query() q: SaleListQueryDto) {
    return this.saleService.list(eid, q);
  }

  @Get(':id')
  findById(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.saleService.findById(eid, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.saleService.cancel(eid, id);
  }
}
