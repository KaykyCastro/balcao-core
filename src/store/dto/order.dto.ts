import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsEmail, IsIn, IsInt, IsMongoId, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ORDER_STATUSES } from '../store.rules';

export class CartItemDto {
  @IsMongoId() productId: string;
  @IsInt() @Min(1) @Max(999) quantity: number;
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

export class CheckoutDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CartItemDto) items: CartItemDto[];
  @ValidateNested() @Type(() => CustomerDto) customer: CustomerDto;
  /** Obrigatório, exceto na retirada na loja. */
  @IsOptional() @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
  @IsString() @MaxLength(40) shippingOptionId: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  /** Origem do cliente (o navegador lembra se ele chegou pela página "Lojas no Balcão"). */
  @IsOptional() @IsIn(['store', 'directory']) source?: 'store' | 'directory';
}

export class OrderAccessDto {
  @IsString() @Length(20, 64) t: string;
}

export class OrderConfirmDto {
  @IsString() @Length(20, 64) t: string;
  /** `payment_id` que o Mercado Pago devolve na volta do checkout. */
  @IsString() @Matches(/^\d{1,20}$/) paymentId: string;
}

export class OrderListQueryDto extends PaginationQueryDto {
  /** 'open' = pagos ainda não entregues; 'all' = tudo menos os abandonados. */
  @IsOptional() @IsIn(['open', 'all', ...ORDER_STATUSES]) status?: string;
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
}

export class DirectoryQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(20) segment?: string;
  @IsOptional() @IsString() @MaxLength(2) state?: string;
}
