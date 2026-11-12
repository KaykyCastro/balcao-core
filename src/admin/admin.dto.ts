import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
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

  /** Loja online, venda pelo link da própria loja (bps: 50 = 0,5%). */
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

export class StoreListQuery extends PaginationQueryDto {
  /** online | offline | paused (no ar sem aceitar pedidos) | blocked (pela plataforma) | no_legal (no ar sem dados do vendedor) */
  @IsOptional() @IsIn(['online', 'offline', 'paused', 'blocked', 'no_legal'])
  status?: 'online' | 'offline' | 'paused' | 'blocked' | 'no_legal';
}

export class BlockStoreDto {
  /** Motivo (vai para o lojista e para a auditoria). */
  @IsString() @MinLength(5) @MaxLength(300)
  reason: string;

  /** Avisa o lojista pela caixa de mensagens do painel. */
  @IsOptional() @IsBoolean()
  notify?: boolean;
}

export class UnblockStoreDto {
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;

  @IsOptional() @IsBoolean()
  notify?: boolean;
}

export class ShopperListQuery extends PaginationQueryDto {}

/** Atendimento a pedido do titular (LGPD, art. 18) recebido por e-mail ou outro canal. */
export class PrivacyRequestDto {
  /** Como e quando o pedido chegou (fica na auditoria). Ex.: "E-mail do titular em 02/11". */
  @IsString() @MinLength(5) @MaxLength(300)
  reason: string;
}

export class DisputeListQuery extends PaginationQueryDto {
  @IsOptional() @IsIn(['open', 'escalated', 'resolved']) status?: 'open' | 'escalated' | 'resolved';
}
export class ResolveDisputeDto {
  @IsIn(['refund', 'seller']) decision: 'refund' | 'seller';
  @IsString() @MinLength(5) @MaxLength(300) note: string;
}

/** Reduzir o valor de uma fatura pendente (o motivo vai para a fatura e para a auditoria). */
export class ReduceInvoiceDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100_000_000)
  amountCents: number;
  @IsString() @MinLength(3) @MaxLength(300)
  note: string;
}

/** Mês grátis: 'AAAA-MM'. */
export class FreeMonthDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Mês inválido (use AAAA-MM)' })
  period: string;
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}
