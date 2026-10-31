import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { LOGO_RE, PASSWORD_MSG } from './enterprise-create.dto';

export class EnterpriseUpdateDto {
  @IsOptional() @IsNotEmpty() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(400_000) @Matches(LOGO_RE, { message: 'Logo inválida' })
  logo?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail() @MaxLength(254)
  email?: string;

  @IsOptional() @IsString() @MinLength(8, { message: PASSWORD_MSG }) @MaxLength(72, { message: PASSWORD_MSG })
  password?: string;

  @IsOptional() @IsString() @MaxLength(18)
  cnpj?: string;

  /** Obrigatória para trocar e-mail ou senha: um token roubado não basta para tomar a conta. */
  @IsOptional() @IsString() @MaxLength(72)
  currentPassword?: string;
}
