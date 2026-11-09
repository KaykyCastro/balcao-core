import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { LegalService } from './legal.service';
import { PrivacyListQuery, PrivacyRequestDto, PrivacyUpdateDto, PrivacyVerifyDto } from './legal.dto';
import type { RequestKind, RequestStatus, RequesterRole } from './legal.rules';

/** Pedidos do titular (LGPD, art. 18): qualquer pessoa, com confirmação por e-mail. */
@Public()
@Controller('public/privacy')
export class PublicPrivacyController {
  constructor(private readonly legal: LegalService) {}

  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('requests')
  create(@Body() dto: PrivacyRequestDto, @Req() req: Request) {
    return this.legal.createRequest({ ...dto, role: dto.role as RequesterRole, kind: dto.kind as RequestKind }, req.ip ?? '');
  }

  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @Post('requests/:id/verify')
  @HttpCode(200)
  verify(@Param('id', ParseMongoIdPipe) id: string, @Body() dto: PrivacyVerifyDto) {
    return this.legal.verifyRequest(id, dto.code);
  }
}

/** Lojista: cópia dos dados da conta (portabilidade). Liberada mesmo com a conta bloqueada por fatura. */
@Controller('privacy')
export class PrivacyController {
  constructor(private readonly legal: LegalService) {}

  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @AllowWhenBlocked()
  @Get('export')
  @Header('Cache-Control', 'no-store')
  export(@CurrentEnterprise() eid: string) {
    return this.legal.exportAccount(eid);
  }
}

/** Admin: fila de pedidos com prazo, resposta e histórico. */
@Roles('admin')
@Controller('admin/privacy-requests')
export class AdminPrivacyController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  list(@Query() q: PrivacyListQuery) { return this.legal.adminList(q.status); }

  @Patch(':id')
  update(@Param('id', ParseMongoIdPipe) id: string, @Body() dto: PrivacyUpdateDto, @Req() req: Request) {
    const actor = (req.user as { email?: string } | undefined)?.email ?? 'admin';
    return this.legal.adminUpdate(id, { status: dto.status as RequestStatus, response: dto.response }, actor);
  }
}
