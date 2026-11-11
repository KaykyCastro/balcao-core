import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsMongoId, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Equals, IsISO8601 } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ORDER_STATUSES } from '../store.rules';

export class OptionChoiceDto {
  @IsString() @Matches(/^[a-z0-9]{1,16}$/i) g: string;
  @IsString() @Matches(/^[a-z0-9]{1,16}$/i) i: string;
  @IsInt() @Min(1) @Max(20) q: number;
}
export class CartItemDto {
  @IsMongoId() productId: string;
  @IsInt() @Min(1) @Max(999) quantity: number;
  /** Adicionais escolhidos (cardápio). O preço deles é calculado na API pelas regras do produto. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => OptionChoiceDto) options?: OptionChoiceDto[];
  /** Observação desta linha ("sem cebola"). */
  @IsOptional() @IsString() @MaxLength(140) note?: string;
}

export class QuoteDto {
  @Matches(/^\d{5}-?\d{3}$/, { message: 'CEP inválido' }) cep: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CartItemDto) items: CartItemDto[];
}

class CustomerDto {
  @IsString() @MinLength(3) @MaxLength(80) name: string;
  @IsEmail() @MaxLength(120) email: string;
  @Matches(/^\d{10,11}$/, { message: 'Telefone: DDD + número' }) phone: string;
  @IsOptional() @Matches(/^(\d{11}|\d{14})?$/, { message: 'CPF/CNPJ inválido' }) document?: string;
}
class AddressDto {
  @Matches(/^\d{8}$/, { message: 'CEP inválido' }) cep: string;
  @IsString() @MinLength(2) @MaxLength(120) street: string;
  @IsString() @MinLength(1) @MaxLength(12) number: string;
  @IsOptional() @IsString() @MaxLength(60) complement?: string;
  @IsString() @MinLength(2) @MaxLength(60) district: string;
  @IsString() @MinLength(2) @MaxLength(60) city: string;
  @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida' }) state: string;
}

export class PayOnDeliveryChoiceDto {
  @IsIn(['cash', 'card', 'pix']) method: 'cash' | 'card' | 'pix';
  /** Dinheiro: troco para quanto. */
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) changeForCents?: number;
}
export class CollectDto {
  @IsIn(['cash', 'card', 'pix', 'other']) method: 'cash' | 'card' | 'pix' | 'other';
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) cashReceivedCents?: number;
}

export class CheckoutDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CartItemDto) items: CartItemDto[];
  @ValidateNested() @Type(() => CustomerDto) customer: CustomerDto;
  /** Obrigatório, exceto na retirada na loja. */
  @IsOptional() @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
  @IsString() @MaxLength(40) shippingOptionId: string;
  /** Pedido na mesa (shippingOptionId = 'table'): número da mesa. */
  @IsOptional() @IsInt() @Min(1) @Max(300) table?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  /** Origem do cliente (o navegador lembra se ele chegou pela página "Lojas no Balcão"). */
  @IsOptional() @IsIn(['store', 'directory']) source?: 'store' | 'directory';
  /** Aceite das condições da compra (termos, trocas e privacidade da loja). Sem ele, não há pedido. */
  @Equals(true, { message: 'Para finalizar, confirme que leu e concorda com as condições da compra' }) acceptTerms: boolean;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) termsVersion?: string;
  /** Compra sem conta: comprovante de que o e-mail foi confirmado com o código (POST .../email-code/verify). */
  @IsOptional() @IsString() @MaxLength(80) emailToken?: string;
  /** Pagar na entrega ou na retirada (quando a loja aceita). Sem isso, paga online pelo Mercado Pago. */
  @IsOptional() @ValidateNested() @Type(() => PayOnDeliveryChoiceDto) payOnDelivery?: PayOnDeliveryChoiceDto;
  /** Cupom de desconto da loja. */
  @IsOptional() @IsString() @MaxLength(24) couponCode?: string;
  /** Usar o crédito de cashback nesta loja (só comprador com conta). */
  @IsOptional() @IsBoolean() useCredit?: boolean;
}

/** Prévia do cupom no carrinho/checkout. */
export class CouponCheckDto {
  @IsString() @MaxLength(24) code: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CartItemDto) items: CartItemDto[];
  @IsOptional() @IsEmail() @MaxLength(120) email?: string;
}

export class EmailCodeDto {
  @IsEmail({}, { message: 'E-mail inválido' }) @MaxLength(120) email: string;
}
export class EmailVerifyDto extends EmailCodeDto {
  @Matches(/^\d{6}$/, { message: 'O código tem 6 números' }) code: string;
}

export class OrderAccessDto {
  @IsString() @Length(20, 64) t: string;
}

export class OrderConfirmDto {
  @IsString() @Length(20, 64) t: string;
  /** `payment_id` que o Mercado Pago devolve na volta do checkout. */
  /** payment_id antigo (número) ou order_id da API de Orders (ORD…). */
  @IsString() @Matches(/^(\d{1,20}|ORD[A-Z0-9]{10,40})$/) paymentId: string;
}

export class OrderListQueryDto extends PaginationQueryDto {
  /** 'open' = pagos ainda não entregues; 'all' = tudo menos os abandonados. */
  @IsOptional() @IsIn(['open', 'all', 'to_ship', 'late', 'dispute', 'to_print', ...ORDER_STATUSES]) status?: string;
}

export class OrderStatusDto {
  @IsIn(['preparing', 'ready_for_pickup', 'shipped', 'delivered']) status: 'preparing' | 'ready_for_pickup' | 'shipped' | 'delivered';
  @IsOptional() @IsString() @MaxLength(60) trackingCode?: string;
  @IsOptional() @IsString() @MaxLength(300) @Matches(/^$|^https:\/\/\S+$/, { message: 'Link de rastreio deve começar com https://' }) trackingUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class OrderCancelDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class PublicProductsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsMongoId() categoryId?: string;
  @IsOptional() @IsIn(['relevance', 'price_asc', 'price_desc', 'name', 'new', 'sold']) sort?: string;
  /** Só ofertas (desconto, preço online menor ou promoção ativa). */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true' || value === '1') @IsBoolean() offers?: boolean;
  /** Token de prévia do lojista (loja ainda desligada). */
  @IsOptional() @IsString() @MaxLength(200) preview?: string;
  /** Só estes produtos (componente "produtos escolhidos" do construtor), separados por vírgula, na ordem pedida. */
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{24}(,[a-f0-9]{24}){0,47}$/, { message: 'Lista de produtos inválida' }) ids?: string;
}

/** Busca de produtos do marketplace: filtros de todas as lojas listadas. */
export class MarketProductsQueryDto extends PublicProductsQueryDto {
  @IsOptional() @IsString() @MaxLength(20) segment?: string;
  /** Só as últimas unidades (1 a 3 em estoque). */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true' || value === '1') @IsBoolean() lowStock?: boolean;
}

/** Ids de produtos e visitante (recomendações e curtidas). */
export class VisitorQueryDto {
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{32}$/, { message: 'Visitante inválido' }) visitorId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) limit?: number;
}

export class DirectoryQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(20) segment?: string;
  @IsOptional() @IsString() @MaxLength(2) state?: string;
}

export class DisputeDto {
  @IsIn(['not_received', 'damaged', 'different', 'regret']) reason: 'not_received' | 'damaged' | 'different' | 'regret';
  @IsString() @MinLength(10, { message: 'Conte em poucas palavras o que aconteceu (mínimo 10 letras)' }) @MaxLength(1000) message: string;
}
export class PublicDisputeDto extends DisputeDto {
  @IsString() @Length(20, 64) t: string;
}
export class ReplyDto {
  @IsString() @MinLength(5) @MaxLength(1000) message: string;
}

export class LabelDto {
  /** Serviço do Melhor Envio (id). Vazio = o que o cliente escolheu no checkout. */
  @IsOptional() @IsInt() @Min(1) @Max(100_000) serviceId?: number;
  /** Chave da NF-e (44 números). Sem ela, vai com declaração de conteúdo. */
  @IsOptional() @Matches(/^\d{44}$/, { message: 'Chave da nota: 44 números' }) invoiceKey?: string;
}
export class LabelsPrintDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @IsMongoId({ each: true }) ids: string[];
}

/** Impressão automática: a partir de quando este computador imprime pedidos (ISO 8601). */
export class PrintQueueDto {
  @IsISO8601() since: string;
}
