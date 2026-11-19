import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { EDITABLE_METHODS } from './payment-edit.rules';
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;
class SaleManageQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['pos', 'online']) channel?: 'pos' | 'online';
  @IsOptional() @IsIn(['completed', 'cancelled']) status?: 'completed' | 'cancelled';
  @IsOptional() @IsIn(['cash', 'pix', 'card', 'other', 'fiado', 'online', 'credit', 'exchange']) paymentMethod?: string;
  @IsOptional() @Matches(DAY, { message: 'Data inválida (use AAAA-MM-DD)' }) from?: string;
  @IsOptional() @Matches(DAY, { message: 'Data inválida (use AAAA-MM-DD)' }) to?: string;
}

/** Corrigir a forma de pagamento: nova forma, motivo e a senha do dono. */
class PaymentEditDto {
  @IsIn([...EDITABLE_METHODS]) paymentMethod: string;
  @IsString() @MaxLength(200) reason: string;
  @IsString() @MaxLength(72) ownerPassword: string;
}

@Controller('sale')
export class SaleController {
  constructor(private readonly saleService: SaleService) {}

  /** Envie `Idempotency-Key` (8 a 64 caracteres) para poder repetir o pedido sem vender duas vezes. */
  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: SaleCreateDto, @Req() req: { user: { staff?: { id: string; name: string } } }, @Headers('idempotency-key') key?: string) {
    if (key !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new BadRequestException('Idempotency-Key inválida');
    return this.saleService.create(eid, dto, key, undefined, req.user.staff ? { id: req.user.staff.id, name: req.user.staff.name } : null);
  }

  @Get()
  list(@CurrentEnterprise() eid: string, @Query() q: SaleListQueryDto) {
    return this.saleService.list(eid, q);
  }

  /** Página "Gestão de vendas": filtros por período, canal, forma, situação e busca. */
  @Get('manage')
  manage(@CurrentEnterprise() eid: string, @Query() q: SaleManageQueryDto) {
    return this.saleService.manage(eid, q);
  }

  /** Corrige a forma de pagamento de uma venda do balcão (senha do dono). Poucas tentativas por minuto. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':id/payment-method') @HttpCode(200)
  editPayment(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: PaymentEditDto, @Req() req: { user: { staff?: { id: string; name: string } } }) {
    return this.saleService.editPayment(eid, id, dto, req.user.staff ? { id: req.user.staff.id, name: req.user.staff.name } : null);
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
