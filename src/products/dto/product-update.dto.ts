import { IsBoolean, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ArrayMaxSize, IsArray } from 'class-validator';
import { IMAGE_RE, MAX_IMAGES } from './product-create.dto';

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

  /** Até 8 fotos; a primeira vira a capa. Substitui a lista inteira. */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_IMAGES, { message: `Até ${MAX_IMAGES} fotos por produto` })
  @IsString({ each: true }) @MaxLength(400_000, { each: true }) @Matches(IMAGE_RE, { each: true, message: 'Imagem inválida' })
  images?: string[];

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

  /** Preço na loja online (reais). null/0 = usa o preço do balcão. */
  @IsOptional() @ValidateIf((o) => o.onlinePrice !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000)
  onlinePrice?: number | null;

  /** Adicionais (grupos de opções do cardápio). Validados por sanitizeOptions no serviço; manda a lista inteira. */
  @IsOptional() @IsArray() @ArrayMaxSize(12)
  options?: unknown[];
}
