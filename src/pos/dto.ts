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
export class PosConfigDto {
  @IsOptional() @ValidateNested() @Type(() => PixConfigDto) pix?: PixConfigDto;
  @IsOptional() @ValidateNested() @Type(() => PointConfigDto) point?: PointConfigDto;
  @IsOptional() @ValidateNested() @Type(() => StoneConfigDto) stone?: StoneConfigDto;
}

export class PosChargeDto {
  @IsIn(['credit', 'debit', 'pix']) method: 'credit' | 'debit' | 'pix';
  /** Onde cobrar: maquininha Point, maquininha Stone, Pix pelo Mercado Pago ou Pix na chave do lojista. */
  @IsIn(['mp_point', 'stone', 'mp_pix', 'pix_key']) provider: 'mp_point' | 'stone' | 'mp_pix' | 'pix_key';
  @IsOptional() @IsInt() @Min(1) @Max(12) installments?: number;
  @IsOptional() @IsMongoId() customerId?: string;
  /** Comanda de mesa: cobra o total da conta (sem itens). */
  @IsOptional() @IsMongoId() tabId?: string;
  @ValidateIf((o) => !o.tabId) @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SaleItemInputDto) items: SaleItemInputDto[];
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9-]{8,64}$/) clientKey?: string;
  /** Desconto do carrinho (não vale para comanda de mesa). */
  @IsOptional() @ValidateNested() @Type(() => SaleDiscountDto) discount?: SaleDiscountDto;
}
