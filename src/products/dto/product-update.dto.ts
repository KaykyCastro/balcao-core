import { IsBoolean, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { IMAGE_RE } from './product-create.dto';

export class ProductUpdateDto {
  @IsOptional() @IsNotEmpty() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsNotEmpty() @IsString() @MaxLength(64)
  code?: string;

  @IsOptional() @IsBoolean()
  trackStock?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(1_000_000)
  quantity?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000)
  price?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000)
  priceWithDiscount?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  discountPercentage?: number;

  @IsOptional() @ValidateIf((o) => o.image !== '') @IsString() @MaxLength(400_000) @Matches(IMAGE_RE, { message: 'Imagem inválida' })
  image?: string;

  @IsOptional() @IsMongoId()
  categoryId?: string;

  /** Aparece na loja online. */
  @IsOptional() @IsBoolean()
  showOnline?: boolean;

  /** Embalagem para frete (opcional). */
  @IsOptional() @ValidateIf((o) => o.weightGrams !== null) @IsInt() @Min(1) @Max(100_000)
  weightGrams?: number | null;

  @IsOptional() @ValidateIf((o) => o.heightCm !== null) @IsInt() @Min(1) @Max(200)
  heightCm?: number | null;

  @IsOptional() @ValidateIf((o) => o.widthCm !== null) @IsInt() @Min(1) @Max(200)
  widthCm?: number | null;

  @IsOptional() @ValidateIf((o) => o.lengthCm !== null) @IsInt() @Min(1) @Max(200)
  lengthCm?: number | null;
}
