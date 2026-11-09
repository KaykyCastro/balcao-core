import { Transform, Type } from 'class-transformer';
import { IsEmail, IsInt, ValidateNested, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { LOGO_RE, PASSWORD_MSG } from './enterprise-create.dto';

const HEX = /^#[0-9a-fA-F]{6}$/;
export class PanelThemeDto {
  @Matches(HEX, { message: 'Cor inválida' }) accent!: string;
  @Matches(HEX, { message: 'Cor inválida' }) chart!: string;
}

export class EnterpriseUpdateDto {
  /** Cores do painel; null volta para as cores padrão. */
  @IsOptional()
  @ValidateNested()
  @Type(() => PanelThemeDto)
  panelTheme?: PanelThemeDto | null;

  /** Desconto máximo no carrinho para colaboradores (pontos-base, 0 a 10000). */
  @IsOptional() @IsInt() @Min(0) @Max(10_000)
  staffMaxDiscountBps?: number;

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
