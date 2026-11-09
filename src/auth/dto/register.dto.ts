import { Equals, IsOptional, IsString, Matches } from 'class-validator';
import { EnterpriseCreateDto } from '../../enterprise/dto/enterprise-create.dto';

/** Cadastro público (site e app): além dos dados da empresa, exige o aceite dos Termos de Uso. */
export class RegisterDto extends EnterpriseCreateDto {
  @Equals(true, { message: 'Para criar a conta é preciso ler e aceitar os Termos de Uso' })
  acceptTerms: boolean;

  /** Versão dos termos que a pessoa viu (ex.: 2026-10-30). Guardada junto com a data do aceite. */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Versão dos termos inválida' })
  termsVersion?: string;

  /** Versão da Política de Privacidade apresentada no cadastro (ciência, não consentimento: a base legal é o contrato). */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Versão da política inválida' })
  privacyVersion?: string;
}
