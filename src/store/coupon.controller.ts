import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { RewardsService } from './rewards.service';

const CODE = /^\s*[A-Za-z0-9][A-Za-z0-9_-]{2,23}\s*$/;

class CouponDto {
  @Matches(CODE, { message: 'Código: de 3 a 24 letras, números, - ou _' }) code: string;
  @IsOptional() @IsString() @MaxLength(60) title?: string;
  @IsIn(['percent', 'amount']) kind: 'percent' | 'amount';
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(90) percent?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(100) @Max(10_000_000) amountCents?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) minOrderCents?: number;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(100) @Max(10_000_000) maxDiscountCents?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() startsAt?: Date | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() endsAt?: Date | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000) maxUses?: number | null;
  @IsOptional() @IsBoolean() onePerCustomer?: boolean;
  @IsOptional() @IsBoolean() public?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
class CouponPatchDto {
  @IsOptional() @Matches(CODE, { message: 'Código: de 3 a 24 letras, números, - ou _' }) code?: string;
  @IsOptional() @IsString() @MaxLength(60) title?: string;
  @IsOptional() @IsIn(['percent', 'amount']) kind?: 'percent' | 'amount';
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(90) percent?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(100) @Max(10_000_000) amountCents?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) minOrderCents?: number;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(100) @Max(10_000_000) maxDiscountCents?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() startsAt?: Date | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() endsAt?: Date | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000) maxUses?: number | null;
  @IsOptional() @IsBoolean() onePerCustomer?: boolean;
  @IsOptional() @IsBoolean() public?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Cupons da loja online (só o dono: /store-config/* não está liberado para colaboradores). */
@Controller('store-config/coupons')
export class CouponController {
  constructor(private readonly rewards: RewardsService) {}

  @Get()
  list(@CurrentEnterprise() eid: string) { return this.rewards.listCoupons(eid); }

  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: CouponDto) { return this.rewards.createCoupon(eid, dto); }

  @Patch(':id')
  update(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: CouponPatchDto) { return this.rewards.updateCoupon(eid, id, dto); }

  @Delete(':id') @HttpCode(200)
  remove(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.rewards.deleteCoupon(eid, id); }
}
