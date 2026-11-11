import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested, IsObject,
} from 'class-validator';
import { Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import { validDoc } from '../../common/br-doc';
import { FAVICON_RE, SEGMENTS } from '../store.rules';
import { IMAGE_RE } from '../../products/dto/product-create.dto';
import { BODY_FONT_KEYS, FONT_KEYS } from '../fonts.rules';

const HEX = /^#[0-9a-fA-F]{6}$/;
const CEP = /^\d{5}-?\d{3}$/;
const nullableCents = () => [IsOptional(), ValidateIf((_o: unknown, v: unknown) => v !== null), IsInt(), Min(0), Max(100_000_000)];
function NullableCents(): PropertyDecorator { return (t, k) => nullableCents().forEach((d) => d(t, k)); }

class ThemeDto {
  @IsOptional() @Matches(HEX) accent?: string;
  @IsOptional() @IsIn(['light', 'warm', 'dark', 'custom']) background?: string;
  @IsOptional() @Matches(HEX) bgColor?: string;
  @IsOptional() @IsIn([...FONT_KEYS]) font?: string;
  @IsOptional() @IsIn([...BODY_FONT_KEYS]) bodyFont?: string;
  @IsOptional() @IsIn(['rounded', 'soft', 'square']) corners?: string;
  /** Logo no cabeçalho e no rodapé: tamanho, formato (original = proporção da própria logo, sem corte) e nome ao lado. */
  @IsOptional() @IsIn(['sm', 'md', 'lg', 'xl']) logoSize?: string;
  @IsOptional() @IsIn(['original', 'rounded', 'circle']) logoShape?: string;
  @IsOptional() @IsBoolean() logoName?: boolean;
  @IsOptional() @IsIn([2, 3, 4]) columns?: number;
  @IsOptional() @IsIn(['carousel', 'banner', 'simple', 'split', 'duo']) hero?: string;
  @IsOptional() @IsInt() @Min(0) @Max(20) autoplaySec?: number;
  @IsOptional() @IsIn(['compact', 'large']) heroHeight?: string;
  @IsOptional() @IsBoolean() showStock?: boolean;
  /** Modelo de loja: muda o jeito dos cartões e das seções (roupas, beleza, mercado, cardápio de bar). */
  @IsOptional() @IsIn(['classic', 'fashion', 'beauty', 'market', 'menu', 'bistro', 'delivery', 'atelier', 'jewel', 'street', 'boutique', 'retail', 'glow']) layout?: string;
  @IsOptional() @IsIn(['classic', 'editorial', 'centered', 'split', 'bar']) header?: 'classic' | 'editorial' | 'centered' | 'split' | 'bar';
  @IsOptional() @IsInt() @Min(0) @Max(12) installments?: number;
}
export const SLIDE_LINK_RE = /^(|#produtos|#ofertas|cat:[a-f0-9]{24}|p:[a-f0-9]{24}|https:\/\/[^\s"'<>]{1,400})$/;
/** Vídeo enviado para a loja (media:<id>) ou link direto https de um arquivo de vídeo. */
export const VIDEO_RE = /^(|media:[a-f0-9]{24}|https?:\/\/[^\s"'<>]{1,400})$/; // URL do R2; media:<id> = vídeo antigo do GridFS
export const HIGHLIGHT_ICONS = ['truck', 'pix', 'card', 'shield', 'gift', 'refresh', 'clock', 'star', 'pin', 'chat', 'leaf', 'percent'] as const;
class SlideDto {
  /** Imagem (ou capa do vídeo). Pode ficar vazia quando o banner é um vídeo. */
  @IsOptional() @ValidateIf((_o, v) => v !== '') @IsString() @MaxLength(700_000) @Matches(IMAGE_RE, { message: 'Imagem do banner inválida' }) image?: string;
  @IsOptional() @IsString() @Matches(VIDEO_RE, { message: 'Vídeo do banner inválido' }) video?: string;
  @IsOptional() @IsString() @MaxLength(70) title?: string;
  @IsOptional() @IsString() @MaxLength(140) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(30) cta?: string;
  @IsOptional() @IsString() @Matches(SLIDE_LINK_RE, { message: 'Link do banner inválido' }) link?: string;
  @IsOptional() @IsIn(['left', 'center']) align?: string;
  @IsOptional() @IsIn(['light', 'dark']) tone?: string;
}
class ReelDto {
  @IsString() @Matches(VIDEO_RE, { message: 'Vídeo inválido' }) video: string;
  @IsMongoId({ message: 'Escolha o produto do vídeo' }) productId: string;
  @IsOptional() @IsString() @MaxLength(60) title?: string;
}
class HighlightDto {
  @IsIn(HIGHLIGHT_ICONS as unknown as string[]) icon: string;
  @IsString() @MaxLength(40) title: string;
  @IsOptional() @IsString() @MaxLength(80) text?: string;
}
class TablesDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(300) count?: number;
  @IsOptional() @IsString() @MaxLength(20) label?: string;
  @IsOptional() @IsIn(['tab', 'upfront']) payment?: 'tab' | 'upfront';
  /** Taxa de serviço (gorjeta) em centésimos de %: 1000 = 10%. */
  @IsOptional() @IsInt() @Min(0) @Max(2000) serviceRateBps?: number;
}
class PayOnDeliveryDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(['cash', 'card', 'pix'], { each: true }) methods?: string[];
}
class ContactsDto {
  @IsOptional() @IsString() @Matches(/^$|^\+?\d{10,13}$/, { message: 'WhatsApp: só números com DDD' }) whatsapp?: string;
  @IsOptional() @IsString() @Matches(/^$|^@?[A-Za-z0-9._]{1,30}$/, { message: 'Instagram inválido' }) instagram?: string;
  @IsOptional() @ValidateIf((o) => o.email !== '') @IsEmail() @MaxLength(120) email?: string;
}
@ValidatorConstraint({ name: 'doc' })
class DocConstraint implements ValidatorConstraintInterface {
  validate(v: unknown) { return typeof v === 'string' && validDoc(v); }
  defaultMessage() { return 'CPF ou CNPJ inválido'; }
}
class LegalDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @ValidateIf((_o, v) => v !== '') @Validate(DocConstraint) document?: string;
  @IsOptional() @IsString() @MaxLength(240) address?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== '') @IsEmail({}, { message: 'E-mail do vendedor inválido' }) @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
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
class SenderDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @Matches(/^$|^\d{10,11}$/, { message: 'Telefone do remetente: DDD + número' }) phone?: string;
  @IsOptional() @ValidateIf((o) => o.email !== '') @IsEmail() @MaxLength(120) email?: string;
  @IsOptional() @IsString() @ValidateIf((_o, v) => v !== '') @Validate(DocConstraint) document?: string;
  @IsOptional() @IsString() @MaxLength(120) street?: string;
  @IsOptional() @IsString() @MaxLength(12) number?: string;
  @IsOptional() @IsString() @MaxLength(60) complement?: string;
  @IsOptional() @IsString() @MaxLength(60) district?: string;
  @IsOptional() @IsString() @MaxLength(60) city?: string;
  @IsOptional() @Matches(/^$|^[A-Za-z]{2}$/) state?: string;
}
class MelhorEnvioDto {
  @IsOptional() @ValidateNested() @Type(() => SenderDto) sender?: SenderDto;
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

class SeoDto {
  @IsOptional() @IsString() @MaxLength(70) title?: string;
  @IsOptional() @IsString() @MaxLength(160) description?: string;
  @IsOptional() @ValidateIf((o) => o.favicon !== '') @IsString() @MaxLength(140_000) @Matches(FAVICON_RE, { message: 'Favicon: use uma imagem PNG, ICO ou WebP' }) favicon?: string;
}

/** Cashback da loja: de 1% a 20% (em pontos-base) e validade do crédito de 30 a 365 dias. */
export class CashbackDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(100) @Max(2000) rateBps?: number;
  @IsOptional() @IsInt() @Min(30) @Max(365) expiresDays?: number;
}

export class StoreUpdateDto {
  @IsOptional() @IsIn(['ecommerce', 'whatsapp', 'catalog', 'menu']) mode?: 'ecommerce' | 'whatsapp' | 'catalog' | 'menu';
  @IsOptional() @ValidateNested() @Type(() => SeoDto) seo?: SeoDto;
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
  @IsOptional() @IsString() @MaxLength(120) hours?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => SlideDto) slides?: SlideDto[];
  @IsOptional() @ValidateNested() @Type(() => ThemeDto) theme?: ThemeDto;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ReelDto) reels?: ReelDto[];
  @IsOptional() @IsString() @MaxLength(60) reelsTitle?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => HighlightDto) highlights?: HighlightDto[];
  @IsOptional() @ValidateNested() @Type(() => TablesDto) tables?: TablesDto;
  @IsOptional() @ValidateNested() @Type(() => PayOnDeliveryDto) payOnDelivery?: PayOnDeliveryDto;
  @IsOptional() @ValidateNested() @Type(() => ContactsDto) contacts?: ContactsDto;
  @IsOptional() @ValidateNested() @Type(() => PoliciesDto) policies?: PoliciesDto;
  @IsOptional() @ValidateNested() @Type(() => LegalDto) legal?: LegalDto;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) minOrderCents?: number;
  @IsOptional() @ValidateNested() @Type(() => ShippingDto) shipping?: ShippingDto;
  @IsOptional() @ValidateNested() @Type(() => CashbackDto) cashback?: CashbackDto;
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

/** Construtor de sites: a página inteira (validada por builder.rules). `publish` põe no ar; sem ele, salva o rascunho. */
export class StorePageDto {
  @IsObject() page: Record<string, unknown>;
  @IsOptional() @IsBoolean() publish?: boolean;
}

/** Componente Código: texto JSX restrito (no máximo 20 mil caracteres). */
export class CodeCompileDto {
  @IsString() @MaxLength(20_000) code: string;
}
