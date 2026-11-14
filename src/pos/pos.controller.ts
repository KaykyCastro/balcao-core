import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { PosChargeDto, PosConfigDto, TapResultDto } from './dto';
import { PosService } from './pos.service';

class TerminalDto { @IsString() @MaxLength(80) terminalId: string }

/** Pagamentos no balcão: configuração (Pix, maquininhas) e cobranças do caixa. */
@Controller('pos')
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get('config') view(@CurrentEnterprise() eid: string) { return this.pos.view(eid); }
  @Put('config') update(@CurrentEnterprise() eid: string, @Body() dto: PosConfigDto) { return this.pos.update(eid, dto); }

  /** Maquininhas Point da conta Mercado Pago conectada. */
  @Get('terminals') terminals(@CurrentEnterprise() eid: string) { return this.pos.terminals(eid); }
  @Post('terminals/pdv') @HttpCode(200)
  pdv(@CurrentEnterprise() eid: string, @Body() dto: TerminalDto) { return this.pos.setPdv(eid, dto.terminalId); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('charges')
  charge(@CurrentEnterprise() eid: string, @Body() dto: PosChargeDto, @Req() req: { user: { staff?: { id: string; name: string } } }, @Headers('idempotency-key') key?: string) {
    const st = req.user.staff;
    return this.pos.charge(eid, { ...dto, clientKey: dto.clientKey ?? (key && /^[A-Za-z0-9-]{8,64}$/.test(key) ? key : undefined) }, st ? { id: st.id, name: st.name } : null);
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('charges/:id') status(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.pos.status(eid, id); }

  /** Pix na chave: o caixa conferiu no banco que o dinheiro caiu. */
  @Post('charges/:id/confirm') @HttpCode(200)
  confirm(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Req() req: { user?: { email?: string } }) { return this.pos.confirm(eid, id, req.user?.email ?? 'caixa'); }

  /** Retorno do InfiniteTap: o app repassa o resultado que a InfinitePay devolveu no deep link. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('charges/:id/tap-result') @HttpCode(200)
  tapResult(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: TapResultDto) { return this.pos.tapResult(eid, id, dto); }

  @Post('charges/:id/cancel') @HttpCode(200)
  cancel(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.pos.cancel(eid, id); }
}
