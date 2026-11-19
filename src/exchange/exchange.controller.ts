import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { ExchangeCreateDto, ExchangeListDto, ExchangeLookupDto, ExchangeQuoteDto } from './dto';
import { ExchangeService } from './exchange.service';

type Req_ = { user: { staff?: { id: string; name: string } } };
const who = (req: Req_) => (req.user.staff ? { id: req.user.staff.id, name: req.user.staff.name } : null);

/** Trocas e devoluções no balcão (dono e colaborador com permissão de vender). */
@Controller('exchanges')
export class ExchangeController {
  constructor(private readonly svc: ExchangeService) {}

  /** A venda do comprovante, com o que ainda pode ser devolvido e o prazo. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('sale') lookup(@CurrentEnterprise() eid: string, @Query() q: ExchangeLookupDto) { return this.svc.lookup(eid, q.code); }

  @Post('quote') @HttpCode(200)
  quote(@CurrentEnterprise() eid: string, @Body() dto: ExchangeQuoteDto) { return this.svc.quote(eid, dto); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: ExchangeCreateDto, @Req() req: Req_, @Headers('idempotency-key') key?: string) {
    return this.svc.create(eid, dto, who(req), key && /^[A-Za-z0-9-]{8,64}$/.test(key) ? key : undefined);
  }

  /** Histórico de trocas (para sempre). */
  @Get() list(@CurrentEnterprise() eid: string, @Query() q: ExchangeListDto) { return this.svc.list(eid, q.page ?? 1, q.limit ?? 20, q.from, q.to); }
  @Get(':id') get(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.svc.get(eid, id); }
}
