import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { SaleDiscountDto, SaleItemInputDto } from '../sale/dto/sale-create.dto';

class PixConfigDto {
  @IsOptional() @IsIn(['off', 'key', 'mercadopago']) mode?: 'off' | 'key' | 'mercadopago';
  @IsOptional() @IsIn(['cpf', 'cnpj', 'email', 'phone', 'random']) keyType?: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';
  @IsOptional() @IsString() @MaxLength(80) key?: string;
  @IsOptional() @IsString() @MaxLength(60) holder?: string;
  @IsOptional() @IsString() @MaxLength(40) city?: string;
}
class PointConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(80) terminalId?: string;
  @IsOptional() @IsString() @MaxLength(40) label?: string;
}
class StoneConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9-]{0,40}$/, { message: 'Número de série inválido' }) serial?: string;
  /** Chave secreta (sk_...). Vazio = apagar. Nunca volta para o navegador. */
  @IsOptional() @IsString() @Matches(/^(|sk_[A-Za-z0-9_]{8,120})$/, { message: 'A chave secreta começa com sk_' }) secretKey?: string;
}
class TapConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** InfiniteTag da conta InfinitePay (com ou sem $). */
  @IsOptional() @IsString() @Matches(/^\$?[A-Za-z0-9._-]{0,40}$/, { message: 'InfiniteTag inválida' }) handle?: string;
  /** CPF ou CNPJ da conta InfinitePay (opcional, confere a conta no retorno). */
  @IsOptional() @IsString() @Matches(/^[0-9./-]{0,20}$/, { message: 'Documento inválido' }) doc?: string;
}
export class PosConfigDto {
  @IsOptional() @ValidateNested() @Type(() => PixConfigDto) pix?: PixConfigDto;
  @IsOptional() @ValidateNested() @Type(() => PointConfigDto) point?: PointConfigDto;
  @IsOptional() @ValidateNested() @Type(() => StoneConfigDto) stone?: StoneConfigDto;
  @IsOptional() @ValidateNested() @Type(() => TapConfigDto) tap?: TapConfigDto;
}

export class PosChargeDto {
  @IsIn(['credit', 'debit', 'pix']) method: 'credit' | 'debit' | 'pix';
  /** Onde cobrar: maquininha Point, maquininha Stone, Pix pelo Mercado Pago ou Pix na chave do lojista. */
  @IsIn(['mp_point', 'stone', 'mp_pix', 'pix_key', 'infinitetap']) provider: 'mp_point' | 'stone' | 'mp_pix' | 'pix_key' | 'infinitetap';
  /** InfiniteTap: para onde a InfinitePay devolve (só o esquema do app). */
  @IsOptional() @IsString() @MaxLength(200) returnUrl?: string;
  @IsOptional() @IsInt() @Min(1) @Max(12) installments?: number;
  @IsOptional() @IsMongoId() customerId?: string;
  /** Comanda de mesa: cobra o total da conta (sem itens). */
  @IsOptional() @IsMongoId() tabId?: string;
  @ValidateIf((o) => !o.tabId) @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SaleItemInputDto) items: SaleItemInputDto[];
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9-]{8,64}$/) clientKey?: string;
  /** Desconto do carrinho (não vale para comanda de mesa). */
  @IsOptional() @ValidateNested() @Type(() => SaleDiscountDto) discount?: SaleDiscountDto;
}

/** Retorno do InfiniteTap, repassado pelo app exatamente como a InfinitePay mandou no deep link. */
export class TapResultDto {
  @IsString() @MaxLength(64) orderId: string;
  @IsOptional() @IsString() @MaxLength(80) nsu?: string;
  @IsOptional() @IsString() @MaxLength(40) aut?: string;
  @IsOptional() @IsString() @MaxLength(40) cardBrand?: string;
  @IsOptional() @IsString() @MaxLength(60) handle?: string;
  @IsOptional() @IsString() @MaxLength(30) merchantDocument?: string;
  @IsOptional() @IsString() @MaxLength(200) warning?: string;
}
