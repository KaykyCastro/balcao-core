import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Logo: data URL de imagem (PNG/JPEG/WebP) ou https. SVG fica de fora (pode carregar script). */
export const LOGO_RE = /^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s"'<>]+)$/; // URL do R2 (ou http da pasta local em desenvolvimento)
export const PASSWORD_MSG = 'A senha precisa ter de 8 a 72 caracteres';

export class EnterpriseCreateDto {
  @IsNotEmpty() @IsString() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(400_000) @Matches(LOGO_RE, { message: 'Logo inválida' })
  logo?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail() @MaxLength(254)
  email: string;

  /** bcrypt só lê os 72 primeiros bytes; limitar evita senha "truncada" sem aviso e DoS por senha gigante. */
  @IsString() @MinLength(8, { message: PASSWORD_MSG }) @MaxLength(72, { message: PASSWORD_MSG })
  password: string;

  @IsOptional() @IsString() @MaxLength(18)
  cnpj?: string;
}
