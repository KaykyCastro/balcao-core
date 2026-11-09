import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { REQUEST_KINDS, REQUEST_STATUSES, REQUESTER_ROLES } from './legal.rules';

export class PrivacyRequestDto {
  @IsString() @Length(2, 120) name: string;
  @IsEmail() @MaxLength(160) email: string;
  @IsIn(Object.keys(REQUESTER_ROLES)) role: string;
  @IsIn(Object.keys(REQUEST_KINDS)) kind: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9-]{0,60}$/, { message: 'Endereço da loja inválido' }) storeSlug?: string;
  @IsOptional() @IsString() @MaxLength(3000) details?: string;
}
export class PrivacyVerifyDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'Código de 6 números' }) code: string;
}
export class PrivacyUpdateDto {
  @IsIn(REQUEST_STATUSES.filter((s) => s !== 'unverified')) status: string;
  @IsOptional() @IsString() @MaxLength(4000) response?: string;
}
export class PrivacyListQuery {
  @IsOptional() @IsIn(['all', ...REQUEST_STATUSES]) status?: string;
}
