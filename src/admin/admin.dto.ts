import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CAP_MAX_CENTS, TRIAL_MAX_DAYS, ONLINE_RATE_MAX_BPS } from '../settings/settings.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

export class EnterpriseListQuery extends PaginationQueryDto {
  /** active | suspended | blocked (fatura vencida) | trial | overdue (tem fatura vencida) */
  @IsOptional() @IsIn(['active', 'suspended', 'blocked', 'trial'])
  status?: 'active' | 'suspended' | 'blocked' | 'trial';
}

export class InvoiceListQuery extends PaginationQueryDto {
  @IsOptional() @IsIn(['pending', 'paid', 'cancelled'])
  status?: 'pending' | 'paid' | 'cancelled';

  @IsOptional() @IsMongoId()
  enterpriseId?: string;

  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean()
  overdue?: boolean;
}

export class UpdateEnterpriseDto {
  @IsOptional() @IsBoolean()
  suspended?: boolean;

  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;

  @IsOptional() @IsBoolean()
  feeExempt?: boolean;

  /** Soma dias ao fim do teste grátis (ou a partir de hoje, se já acabou). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  extendTrialDays?: number;

  /** Tira dias do teste grátis (se sobrar menos que isso, o teste acaba agora). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  removeTrialDays?: number;

  /** Encerra o teste grátis agora. */
  @IsOptional() @IsBoolean()
  endTrial?: boolean;

  /** Teto mensal da taxa só desta empresa, em centavos. `null` volta ao padrão da plataforma. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(CAP_MAX_CENTS)
  feeCapCents?: number | null;
}

export class UpdateSettingsDto {
  /** Teto da taxa por empresa por mês, em centavos (padrão da plataforma). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(CAP_MAX_CENTS)
  capCents?: number;

  /** Dias de teste grátis para novos cadastros. 0 = sem teste grátis. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(TRIAL_MAX_DAYS)
  trialDays?: number;

  /** Loja online, venda pelo link da própria loja (bps: 150 = 1,5%). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(ONLINE_RATE_MAX_BPS)
  onlineRateBps?: number;

  /** Loja online, cliente vindo da página "Lojas no Balcão" (bps). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(ONLINE_RATE_MAX_BPS)
  directoryRateBps?: number;
}

export class UnblockDto {
  /** Dias de prazo extra para as faturas vencidas (evita bloquear de novo na próxima hora). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60)
  extendDays?: number;
}

export class InvoiceNoteDto {
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class ExtendInvoiceDto extends InvoiceNoteDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(60)
  days: number;
}

export class AuditQuery extends PaginationQueryDto {
  @IsOptional() @IsMongoId()
  enterpriseId?: string;
}
