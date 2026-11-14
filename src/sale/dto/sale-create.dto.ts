import { CASH_MAX_CENTS } from '../../common/money';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

/** Opção escolhida (tamanho, cor, adicional): grupo, opção e quantas vezes. Mesmo formato da loja online. */
export class SaleOptionDto {
  @IsString() @Matches(/^[a-z0-9]{1,16}$/i) g: string;
  @IsString() @Matches(/^[a-z0-9]{1,16}$/i) i: string;
  @IsInt() @Min(1) @Max(20) q: number;
}

export class SaleItemInputDto {
  @IsMongoId()
  productId: string;

  @IsInt() @Min(1) @Max(100_000)
  quantity: number;

  /** Opções do produto. O adicional é calculado pela API com as regras do produto (priceChoice). */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SaleOptionDto)
  options?: SaleOptionDto[];

  /** Observação da linha ("embrulhar para presente"). */
  @IsOptional() @IsString() @MaxLength(140)
  note?: string;
}

/** Desconto no carrinho: `percent` em pontos-base (1000 = 10%) ou `amount` em centavos. O valor final é calculado pela API. */
export class SaleDiscountDto {
  @IsIn(['percent', 'amount']) mode: 'percent' | 'amount';
  @IsInt() @Min(1) @Max(CASH_MAX_CENTS, { message: 'Desconto acima do permitido' }) value: number;
  @IsOptional() @IsString() @MaxLength(120) reason?: string;
}

export class SaleCreateDto {
  @IsIn(['cash', 'pix', 'card', 'other', 'fiado'])
  paymentMethod: 'cash' | 'pix' | 'card' | 'other' | 'fiado';

  /** Obrigatório no fiado; opcional nas demais formas de pagamento. */
  @ValidateIf((o) => o.paymentMethod === 'fiado' || o.customerId !== undefined)
  @IsMongoId()
  customerId?: string;

  /** Só no dinheiro: quanto o cliente entregou, em centavos. O troco é calculado pela API. */
  @IsOptional() @IsInt() @Min(0) @Max(CASH_MAX_CENTS, { message: 'O valor recebido pode ser de no máximo R$ 100.000.000,00' })
  cashReceivedCents?: number;

  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleItemInputDto)
  items: SaleItemInputDto[];

  @IsOptional() @ValidateNested() @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;
}
