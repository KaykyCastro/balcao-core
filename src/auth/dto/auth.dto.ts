import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MSG } from '../../enterprise/dto/enterprise-create.dto';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class ForgotPasswordDto {
  @Transform(lower) @IsEmail() @MaxLength(254)
  email: string;
}
export class ResetPasswordDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/, { message: 'Link inválido ou expirado' })
  token: string;

  @IsString() @MinLength(8, { message: PASSWORD_MSG }) @MaxLength(72, { message: PASSWORD_MSG })
  password: string;
}
export class ChangePasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(72)
  currentPassword: string;

  @IsString() @MinLength(8, { message: PASSWORD_MSG }) @MaxLength(72, { message: PASSWORD_MSG })
  newPassword: string;
}

// ---------------------------------------------------------------- verificação em duas etapas

export class VerifyCodeDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/, { message: 'O código expirou. Entre de novo para receber outro.' })
  challenge: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\D/g, '') : value))
  @IsString() @Matches(/^\d{6}$/, { message: 'O código tem 6 números' })
  code: string;

  /** "Confiar neste aparelho por 30 dias": não pede o código de novo neste navegador/app. */
  @IsOptional() @IsBoolean()
  trustDevice?: boolean;
}

export class ResendCodeDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/, { message: 'O código expirou. Entre de novo para receber outro.' })
  challenge: string;
}

// ---------------------------------------------------------------- login com Google

export class GoogleStartQuery {
  @IsOptional() @IsIn(['web', 'mobile'])
  client?: 'web' | 'mobile';

  /** Desafio PKCE gerado pelo app (obrigatório quando client=mobile). */
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'Requisição inválida' })
  challenge?: string;
}

/** Cadastro novo pelo Google: nome da empresa + aceite dos termos (o e-mail vem do Google). */
export class GoogleCompleteDto {
  @IsString() @MaxLength(3000)
  token: string;

  @IsNotEmpty() @IsString() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(18)
  cnpj?: string;

  @Equals(true, { message: 'Para criar a conta é preciso ler e aceitar os Termos de Uso' })
  acceptTerms: boolean;

  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Versão dos termos inválida' })
  termsVersion?: string;

  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Versão da política inválida' })
  privacyVersion?: string;

  /** Só no app: verificador PKCE que ficou no aparelho. */
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9._~-]{43,128}$/, { message: 'Requisição inválida' })
  verifier?: string;
}

export class MobileGoogleExchangeDto {
  @IsString() @MaxLength(3000)
  code: string;

  @IsString() @Matches(/^[A-Za-z0-9._~-]{43,128}$/, { message: 'Requisição inválida' })
  verifier: string;
}
