import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { IMAGE_RE } from '../../products/dto/product-create.dto';
import { BANNER_LINK_RE } from '../market-banner.rules';

export class MarketBannerDto {
  @IsIn(['hero', 'middle']) placement: 'hero' | 'middle';
  @IsOptional() @IsIn(['promo', 'balcao']) kind?: 'promo' | 'balcao';
  @IsOptional() @IsString() @MaxLength(70) title?: string;
  @IsOptional() @IsString() @MaxLength(140) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(30) cta?: string;
  @IsOptional() @IsString() @Matches(BANNER_LINK_RE, { message: 'Link inválido: use um caminho do site (começando com /) ou um endereço https' }) link?: string;
  @IsString() @MaxLength(1_500_000) @Matches(IMAGE_RE, { message: 'Imagem inválida' }) image: string; // URL do R2 (envio kind 'banner')
  @IsOptional() @IsIn(['light', 'dark']) tone?: 'light' | 'dark';
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() startsAt?: Date | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() endsAt?: Date | null;
  @IsOptional() @IsInt() @Min(0) @Max(999) order?: number;
}

/** Edição: tudo opcional; a imagem só vai quando mudou. */
export class MarketBannerPatchDto {
  @IsOptional() @IsIn(['hero', 'middle']) placement?: 'hero' | 'middle';
  @IsOptional() @IsIn(['promo', 'balcao']) kind?: 'promo' | 'balcao';
  @IsOptional() @IsString() @MaxLength(70) title?: string;
  @IsOptional() @IsString() @MaxLength(140) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(30) cta?: string;
  @IsOptional() @IsString() @Matches(BANNER_LINK_RE, { message: 'Link inválido: use um caminho do site (começando com /) ou um endereço https' }) link?: string;
  @IsOptional() @IsString() @MaxLength(1_500_000) @Matches(IMAGE_RE, { message: 'Imagem inválida' }) image?: string;
  @IsOptional() @IsIn(['light', 'dark']) tone?: 'light' | 'dark';
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() startsAt?: Date | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Date) @IsDate() endsAt?: Date | null;
  @IsOptional() @IsInt() @Min(0) @Max(999) order?: number;
}
