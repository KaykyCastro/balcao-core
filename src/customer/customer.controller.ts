import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsMongoId, IsOptional } from 'class-validator';
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

class AcceptLinkDto {
  @IsOptional() @IsMongoId() customerId?: string;
}

class LinkShopperDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'E-mail inválido' })
  email: string;
}

@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /** Pedidos para ser cliente (do marketplace) e convites enviados, ainda sem resposta. */
  @Get('link-requests')
  requests(@CurrentEnterprise() eid: string) {
    return this.customerService.pendingFor(eid);
  }

  /** Aceita o pedido: `customerId` une ao cadastro que já existe; sem ele, cria um cliente novo. */
  @Post('link-requests/:rid/accept')
  @HttpCode(200)
  accept(@CurrentEnterprise() eid: string, @Param('rid', ParseMongoIdPipe) rid: string, @Body() dto: AcceptLinkDto) {
    return this.customerService.acceptJoin(eid, rid, dto.customerId ?? null);
  }

  /** Recusa o pedido ou cancela o convite. */
  @Post('link-requests/:rid/decline')
  @HttpCode(204)
  decline(@CurrentEnterprise() eid: string, @Param('rid', ParseMongoIdPipe) rid: string) {
    return this.customerService.declineRequest(eid, rid);
  }

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

  /** Convida a pessoa do marketplace a ligar a conta a este cadastro; ela aceita em "Minha conta". */
  @Post(':id/invite')
  invite(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: LinkShopperDto) {
    return this.customerService.invite(eid, id, dto.email);
  }

  /** QR de convite deste cadastro (uso único, 48 h): o cliente lê, entra na conta e fica ligado a ele. */
  @Post(':id/invite-code')
  inviteCode(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.customerService.createInviteCode(eid, id);
  }

  /** Desliga a conta online (só com o saldo quitado). */
  @Delete(':id/link-shopper')
  unlinkShopper(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) {
    return this.customerService.unlinkShopper(eid, id);
  }
}
