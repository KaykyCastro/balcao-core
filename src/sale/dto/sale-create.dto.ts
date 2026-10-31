import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsInt, IsMongoId, IsOptional, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

export class SaleItemInputDto {
  @IsMongoId()
  productId: string;

  @IsInt() @Min(1) @Max(100_000)
  quantity: number;
}

export class SaleCreateDto {
  @IsIn(['cash', 'pix', 'card', 'other', 'fiado'])
  paymentMethod: 'cash' | 'pix' | 'card' | 'other' | 'fiado';

  /** Obrigatório no fiado; opcional nas demais formas de pagamento. */
  @ValidateIf((o) => o.paymentMethod === 'fiado' || o.customerId !== undefined)
  @IsMongoId()
  customerId?: string;

  /** Só no dinheiro: quanto o cliente entregou, em centavos. O troco é calculado pela API. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000)
  cashReceivedCents?: number;

  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleItemInputDto)
  items: SaleItemInputDto[];
}
