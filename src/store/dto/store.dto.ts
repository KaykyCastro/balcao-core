import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { SEGMENTS } from '../store.rules';
import { IMAGE_RE } from '../../products/dto/product-create.dto';

const HEX = /^#[0-9a-fA-F]{6}$/;
const CEP = /^\d{5}-?\d{3}$/;
const nullableCents = () => [IsOptional(), ValidateIf((_o: unknown, v: unknown) => v !== null), IsInt(), Min(0), Max(100_000_000)];
function NullableCents(): PropertyDecorator { return (t, k) => nullableCents().forEach((d) => d(t, k)); }

class ThemeDto {
  @IsOptional() @Matches(HEX) accent?: string;
  @IsOptional() @IsIn(['light', 'warm', 'dark']) background?: string;
  @IsOptional() @IsIn(['modern', 'elegant', 'classic']) font?: string;
  @IsOptional() @IsIn(['rounded', 'soft', 'square']) corners?: string;
  @IsOptional() @IsIn([2, 3, 4]) columns?: number;
  @IsOptional() @IsIn(['banner', 'simple', 'split']) hero?: string;
  @IsOptional() @IsBoolean() showStock?: boolean;
}
class ContactsDto {
  @IsOptional() @IsString() @Matches(/^$|^\+?\d{10,13}$/, { message: 'WhatsApp: só números com DDD' }) whatsapp?: string;
  @IsOptional() @IsString() @Matches(/^$|^@?[A-Za-z0-9._]{1,30}$/, { message: 'Instagram inválido' }) instagram?: string;
  @IsOptional() @ValidateIf((o) => o.email !== '') @IsEmail() @MaxLength(120) email?: string;
}
class PoliciesDto {
  @IsOptional() @IsString() @MaxLength(1500) exchange?: string;
  @IsOptional() @IsString() @MaxLength(1500) shipping?: string;
}
class CepRangeDto {
  @Matches(CEP, { message: 'CEP inválido' }) from: string;
  @Matches(CEP, { message: 'CEP inválido' }) to: string;
}
class PickupDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
  @IsOptional() @IsString() @MaxLength(200) instructions?: string;
}
class LocalDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) priceCents?: number;
  @NullableCents() freeAboveCents?: number | null;
  @IsOptional() @IsString() @MaxLength(60) etaText?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => CepRangeDto) cepRanges?: CepRangeDto[];
}
class FixedDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) priceCents?: number;
  @NullableCents() freeAboveCents?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(60) minDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(90) maxDays?: number;
}
class MelhorEnvioDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() sandbox?: boolean;
  @IsOptional() @ValidateIf((o) => o.originCep !== '') @Matches(CEP, { message: 'CEP de origem inválido' }) originCep?: string;
  @IsOptional() @IsInt() @Min(0) @Max(30) handlingDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) extraFeeCents?: number;
  @NullableCents() freeAboveCents?: number | null;
  /** Só na escrita. "" apaga o token salvo; ausente mantém. Nunca volta na leitura. */
  @IsOptional() @IsString() @MaxLength(4000) token?: string;
}
class PackageDto {
  @IsOptional() @IsInt() @Min(1) @Max(30_000) weightGrams?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) heightCm?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) widthCm?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) lengthCm?: number;
}
class ShippingDto {
  @IsOptional() @ValidateNested() @Type(() => PickupDto) pickup?: PickupDto;
  @IsOptional() @ValidateNested() @Type(() => LocalDto) local?: LocalDto;
  @IsOptional() @ValidateNested() @Type(() => FixedDto) fixed?: FixedDto;
  @IsOptional() @ValidateNested() @Type(() => MelhorEnvioDto) melhorEnvio?: MelhorEnvioDto;
  @IsOptional() @ValidateNested() @Type(() => PackageDto) package?: PackageDto;
}

export class StoreUpdateDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** "Li e concordo com a taxa da loja online": exigido na primeira vez que liga a loja. */
  @IsOptional() @IsBoolean() acceptOnlineFee?: boolean;
  @IsOptional() @IsBoolean() ordersPaused?: boolean;
  @IsOptional() @IsString() @MaxLength(40) slug?: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(140) tagline?: string;
  @IsOptional() @IsString() @MaxLength(1500) about?: string;
  @IsOptional() @IsIn(SEGMENTS as unknown as string[]) segment?: string;
  @IsOptional() @IsString() @MaxLength(60) city?: string;
  @IsOptional() @Matches(/^$|^[A-Za-z]{2}$/) state?: string;
  @IsOptional() @IsBoolean() listed?: boolean;
  @IsOptional() @ValidateIf((o) => o.logo !== '') @IsString() @MaxLength(400_000) @Matches(IMAGE_RE, { message: 'Logo inválido' }) logo?: string;
  @IsOptional() @ValidateIf((o) => o.banner !== '') @IsString() @MaxLength(900_000) @Matches(IMAGE_RE, { message: 'Banner inválido' }) banner?: string;
  @IsOptional() @IsString() @MaxLength(160) notice?: string;
  @IsOptional() @ValidateNested() @Type(() => ThemeDto) theme?: ThemeDto;
  @IsOptional() @ValidateNested() @Type(() => ContactsDto) contacts?: ContactsDto;
  @IsOptional() @ValidateNested() @Type(() => PoliciesDto) policies?: PoliciesDto;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) minOrderCents?: number;
  @IsOptional() @ValidateNested() @Type(() => ShippingDto) shipping?: ShippingDto;
}

export class VisibilityDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsMongoId({ each: true }) ids?: string[];
  @IsOptional() @IsBoolean() all?: boolean;
  @IsBoolean() show: boolean;
}

export class SlugQueryDto {
  @IsString() @MaxLength(60) slug: string;
}

export class MpCallbackDto {
  @IsString() @MaxLength(300) @Matches(/^[\w.-]+$/) code: string;
  @IsString() @MaxLength(200) @Matches(/^[\w.-]+$/) state: string;
}

export class TestQuoteDto {
  @Matches(CEP, { message: 'CEP inválido' }) cep: string;
}
