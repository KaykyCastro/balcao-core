import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { CustomerService } from './customer.service';
import { CustomerCreateDto } from './dto/customer-create.dto';
import { CustomerUpdateDto } from './dto/customer-update.dto';
import { CustomerPaymentDto } from './dto/customer-payment.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';

class CustomerListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  onlyWithDebt?: boolean;
}

@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: CustomerCreateDto) {
    return this.customerService.create(eid, dto);
  }

  @Get()
  list(@CurrentEnterprise() eid: string, @Query() q: CustomerListQueryDto) {
    return this.customerService.list(eid, q);
  }

  @Get(':id')
  getById(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.customerService.getCustomerById(eid, id);
  }

  @Put(':id')
  update(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: CustomerUpdateDto) {
    return this.customerService.update(eid, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.customerService.delete(eid, id);
  }

  /** Cliente pagou (parte do) fiado. */
  @Post(':id/payments')
  receivePayment(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: CustomerPaymentDto) {
    return this.customerService.receivePayment(eid, id, dto);
  }

  @Get(':id/payments')
  listPayments(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.customerService.listPayments(eid, id);
  }
}
