import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import type { StaffSession } from '../staff/staff.service';
import { CashCloseService } from './cash-close.service';

class DayQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data inválida (use AAAA-MM-DD)' })
  day?: string;
}
class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90)
  limit: number = 30;
}
class CloseDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data inválida (use AAAA-MM-DD)' })
  day?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000)
  openingCents?: number;
  @IsInt() @Min(0) @Max(100_000_000)
  countedCents: number;
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}
/** Retirada de dinheiro da gaveta: valor, motivo e a senha do dono. */
class WithdrawDto {
  @IsInt() @Min(1) @Max(100_000_000)
  amountCents: number;
  @IsString() @MaxLength(200)
  reason: string;
  @IsString() @MaxLength(72)
  ownerPassword: string;
}
type Req = { user: { staff?: StaffSession } };

/** Fechamento de caixa: resumo do dia (hoje ou outro) e conferência do dinheiro da gaveta. */
@Controller('cash-close')
export class CashCloseController {
  constructor(private readonly svc: CashCloseService) {}

  /** `?day=AAAA-MM-DD` (vazio = hoje). */
  @Get()
  day(@CurrentEnterprise() eid: string, @Query() q: DayQuery, @Req() req: Req) {
    return this.svc.day(eid, q.day, req.user.staff ?? null);
  }

  @Get('history')
  history(@CurrentEnterprise() eid: string, @Query() q: ListQuery, @Req() req: Req) {
    return this.svc.list(eid, q.limit, req.user.staff ?? null);
  }

  /** Retirar dinheiro da gaveta (sangria) hoje, com a senha do dono. Poucas tentativas por minuto. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('withdrawals') @HttpCode(200)
  withdraw(@CurrentEnterprise() eid: string, @Body() dto: WithdrawDto, @Req() req: Req) {
    return this.svc.withdraw(eid, dto, req.user.staff ?? null);
  }

  @Post()
  close(@CurrentEnterprise() eid: string, @Body() dto: CloseDto, @Req() req: Req) {
    return this.svc.close(eid, dto, req.user.staff ?? null);
  }
}
