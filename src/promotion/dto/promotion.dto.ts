import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDate, IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class PromotionCreateDto {
  @IsMongoId()
  productId: string;

  /** Nome que aparece na tela (ex.: "Queima de estoque"). Vazio = nome do produto. */
  @IsOptional() @IsString() @MaxLength(80)
  name?: string;

  @IsIn(['price', 'percent'])
  mode: 'price' | 'percent';

  /** Preço promocional em reais (mode = price). */
  @ValidateIf((o) => o.mode === 'price')
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(10_000_000)
  price?: number;

  /** Desconto em % sobre o preço cheio (mode = percent). */
  @ValidateIf((o) => o.mode === 'percent')
  @IsInt() @Min(1) @Max(99)
  percent?: number;

  /** Máximo de unidades vendidas no preço promocional. Ausente/null = sem limite. */
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000)
  limitUnits?: number | null;

  @IsOptional() @Type(() => Date) @IsDate()
  startsAt?: Date;

  @IsOptional() @Type(() => Date) @IsDate()
  endsAt?: Date | null;
}

/** Um produto dentro da promoção em grupo: o desconto e o limite de unidades são de cada um. */
export class PromotionGroupItemDto {
  @IsMongoId() productId: string;
  @IsIn(['price', 'percent']) mode: 'price' | 'percent';
  @ValidateIf((o) => o.mode === 'price') @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(10_000_000) price?: number;
  @ValidateIf((o) => o.mode === 'percent') @IsInt() @Min(1) @Max(99) percent?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000) limitUnits?: number | null;
}

/** Promoção com vários produtos (ex.: 10 unidades do X e 2 do Y), com nome e período em comum. */
export class PromotionGroupCreateDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => PromotionGroupItemDto) items: PromotionGroupItemDto[];
  @IsOptional() @Type(() => Date) @IsDate() startsAt?: Date;
  @IsOptional() @Type(() => Date) @IsDate() endsAt?: Date | null;
}

export class PromotionGroupUpdateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Date) @IsDate() endsAt?: Date | null;
}

export class PromotionUpdateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80)
  name?: string;

  /** null = remove o limite. Não pode ficar abaixo do que já foi vendido. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000)
  limitUnits?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Date) @IsDate()
  endsAt?: Date | null;
}

export class PromotionListQueryDto extends PaginationQueryDto {
  /** open = ativas + agendadas; closed = esgotadas, vencidas e encerradas. */
  @IsOptional() @IsIn(['open', 'closed', 'all'])
  @Transform(({ value }) => value ?? 'all')
  filter: 'open' | 'closed' | 'all' = 'all';

  @IsOptional() @IsMongoId()
  productId?: string;
}
