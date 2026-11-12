import { CASH_MAX_CENTS } from '../../common/money';
import { Type } from 'class-transformer';
import { OptionChoiceDto } from './order.dto';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class TabLineDto {
  @IsMongoId() productId: string;
  @IsInt() @Min(1) @Max(50) quantity: number;
  @IsOptional() @IsString() @MaxLength(140) note?: string;
  /** Adicionais escolhidos (cardápio); preço calculado na API. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => OptionChoiceDto) options?: OptionChoiceDto[];
}
export class TabLinesDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => TabLineDto) items: TabLineDto[];
}
export class TabOpenPublicDto {
  @IsInt() @Min(1) @Max(300) table: number;
  @IsString() @MinLength(1) @MaxLength(40) name: string;
}
export class TabOpenDto {
  @IsInt() @Min(1) @Max(300) table: number;
  @IsOptional() @IsString() @MaxLength(40) name?: string;
}
export class TabTokenDto {
  @IsString() @MaxLength(200) t: string;
}
export class TabLinesPublicDto extends TabLinesDto {
  @IsString() @MaxLength(200) t: string;
}
export class TabCallDto {
  @IsString() @MaxLength(200) t: string;
  @IsIn(['waiter', 'bill']) kind: 'waiter' | 'bill';
  /** Pedir a conta: como quer pagar (pelo celular ou com o garçom) e troco para quanto. */
  @IsOptional() @IsIn(['online', 'cash', 'card', 'pix']) pay?: 'online' | 'cash' | 'card' | 'pix';
  @IsOptional() @IsInt() @Min(0) @Max(100_000_00) changeForCents?: number;
}
export class TabServeDto {
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsMongoId({ each: true }) itemIds?: string[];
}
export class TabCancelItemDto {
  @IsOptional() @IsString() @MaxLength(140) reason?: string;
}
export class TabCancelDto {
  @IsString() @MinLength(3) @MaxLength(200) reason: string;
}
export class TabByDto {
  /** Nome de quem fez (garçom), para o histórico. */
  @IsOptional() @IsString() @MaxLength(40) by?: string;
}
export class TabSettleDto extends TabByDto {
  @IsIn(['cash', 'pix', 'card', 'other']) method: 'cash' | 'pix' | 'card' | 'other';
  @IsOptional() @IsInt() @Min(0) @Max(CASH_MAX_CENTS, { message: 'O valor recebido pode ser de no máximo R$ 100.000.000,00' }) cashReceivedCents?: number;
}
export class TabServiceDto {
  @IsBoolean() on: boolean;
}
export class TabMoveDto {
  @IsInt() @Min(1) @Max(300) table: number;
}
export class TabRenameDto {
  @IsString() @MinLength(1) @MaxLength(40) name: string;
}

/** Itens que este computador quer imprimir na cozinha. */
export class TabPrintClaimDto {
  @IsArray() @ArrayMaxSize(50) @IsMongoId({ each: true }) ids: string[];
}
