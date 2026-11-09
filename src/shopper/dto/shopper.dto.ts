import { Type, Transform } from 'class-transformer';
import { Equals, ArrayMaxSize, IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class ShopperAddressDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) label?: string;
  @Transform(trim) @Matches(/^\d{5}-?\d{3}$/, { message: 'CEP inválido' }) cep: string;
  @Transform(trim) @IsString() @Length(1, 120) street: string;
  @Transform(trim) @IsString() @Length(1, 20) number: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) complement?: string;
  @Transform(trim) @IsString() @Length(1, 80) district: string;
  @Transform(trim) @IsString() @Length(1, 80) city: string;
  @Transform(trim) @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida' }) state: string;
}

export class ShopperRegisterDto {
  @Transform(trim) @IsString() @Length(2, 120) name: string;
  @Transform(lower) @IsEmail({}, { message: 'E-mail inválido' }) @MaxLength(160) email: string;
  @IsString() @MinLength(8, { message: 'A senha precisa ter 8+ caracteres' }) @MaxLength(72) password: string;
  @IsOptional() @Transform(trim) @Matches(/^[\d\s()+-]{0,20}$/, { message: 'Telefone inválido' }) phone?: string;
  @Equals(true, { message: 'Para criar a conta, aceite os Termos de Uso e a Política de Privacidade' }) acceptTerms: boolean;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) termsVersion?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) privacyVersion?: string;
  /** Slug da loja onde a conta foi criada (só para o link do e-mail voltar para ela). */
  @IsOptional() @IsString() @MaxLength(60) from?: string;
}

export class ShopperLoginDto {
  @Transform(lower) @IsEmail({}, { message: 'E-mail inválido' }) email: string;
  @IsString() @MaxLength(72) password: string;
}

export class ShopperUpdateDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120) name?: string;
  @IsOptional() @Transform(trim) @Matches(/^[\d\s()+-]{0,20}$/, { message: 'Telefone inválido' }) phone?: string;
  @IsOptional() @Transform(trim) @Matches(/^[\d./-]{0,18}$/, { message: 'CPF/CNPJ inválido' }) document?: string;
  @IsOptional() @ArrayMaxSize(5, { message: 'Até 5 endereços' }) @ValidateNested({ each: true }) @Type(() => ShopperAddressDto) addresses?: ShopperAddressDto[];
}

export class ShopperPasswordDto {
  @IsString() @MaxLength(72) currentPassword: string;
  @IsString() @MinLength(8, { message: 'A senha precisa ter 8+ caracteres' }) @MaxLength(72) password: string;
}

export class ShopperEmailDto {
  @Transform(lower) @IsEmail({}, { message: 'E-mail inválido' }) email: string;
  @IsOptional() @IsString() @MaxLength(60) from?: string;
}

export class ShopperTokenDto {
  @IsString() @Length(20, 128) token: string;
}

export class ShopperResetDto extends ShopperTokenDto {
  @IsString() @MinLength(8, { message: 'A senha precisa ter 8+ caracteres' }) @MaxLength(72) password: string;
}

export class ShopperDeleteDto {
  @IsString() @MaxLength(72) password: string;
}
