import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CASH_MAX_CENTS } from '../common/money';
import { SaleItemInputDto } from '../sale/dto/sale-create.dto';

/** Item da venda original a devolver: a linha (posição no comprovante) e quantas unidades. */
export class ExchangeReturnDto {
  @IsInt() @Min(0) @Max(199) line: number;
  @IsInt() @Min(1) @Max(100_000) quantity: number;
}

export class ExchangeQuoteDto {
  @IsMongoId() saleId: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ExchangeReturnDto) returns: ExchangeReturnDto[];
  /** Produtos novos (troca). Vazio = só devolução. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SaleItemInputDto) items?: SaleItemInputDto[];
}

export class ExchangeCreateDto extends ExchangeQuoteDto {
  /** Como o cliente paga a diferença, quando os produtos novos custam mais que os devolvidos. */
  @IsOptional() @IsIn(['cash', 'pix', 'card', 'other']) payMethod?: 'cash' | 'pix' | 'card' | 'other';
  /** Diferença em dinheiro: quanto o cliente entregou (o troco é calculado pela API). */
  @IsOptional() @IsInt() @Min(0) @Max(CASH_MAX_CENTS) cashReceivedCents?: number;
  /** Se sobrar valor (depois de abater o fiado): crédito no cadastro do cliente ou dinheiro de volta. */
  @IsOptional() @IsIn(['credit', 'refund']) leftover?: 'credit' | 'refund';
  @IsOptional() @IsIn(['cash', 'pix', 'card', 'other']) refundMethod?: 'cash' | 'pix' | 'card' | 'other';
  /** Cliente que recebe o crédito (se a venda original não tinha cliente). */
  @IsOptional() @IsMongoId() customerId?: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class ExchangeLookupDto {
  @IsString() @MaxLength(40) code: string;
}

export class ExchangeListDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}
