import { IsBoolean, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export const IMAGE_RE = /^(https:\/\/[^\s"'<>]+|data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)$/;

export class ProductCreateDto {
  @IsNotEmpty() @IsString() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsNotEmpty() @IsString() @MaxLength(64)
  code: string;

  /** false = estoque ilimitado (serviço). Nesse caso `quantity` é ignorada. */
  @IsOptional() @IsBoolean()
  trackStock?: boolean;

  @ValidateIf((o) => o.trackStock !== false)
  @IsInt() @Min(0) @Max(1_000_000)
  quantity?: number;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000)
  price: number;

  /** Se vier só o percentual, o preço com desconto é calculado. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000)
  priceWithDiscount?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  discountPercentage?: number;

  @IsOptional() @ValidateIf((o) => o.image !== '') @IsString() @MaxLength(400_000) @Matches(IMAGE_RE, { message: 'Imagem inválida' })
  image?: string;

  @IsMongoId()
  categoryId: string;

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
