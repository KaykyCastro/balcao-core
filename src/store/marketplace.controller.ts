import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsMongoId, Matches } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { MarketplaceService } from './marketplace.service';

class EventDto {
  @Matches(/^[a-f0-9]{32}$/, { message: 'Visitante inválido' }) visitorId: string;
  @IsMongoId() productId: string;
  @IsIn(['view', 'like', 'unlike']) kind: 'view' | 'like' | 'unlike';
}
class ForgetDto { @Matches(/^[a-f0-9]{32}$/, { message: 'Visitante inválido' }) visitorId: string }

/**
 * Interações do marketplace (as recomendações saem em StorefrontController, junto dos cartões).
 * O navegador só manda visitorId quando a pessoa aceitou os cookies de preferências.
 */
@Public()
@Controller('public/events')
export class MarketplaceController {
  constructor(private readonly market: MarketplaceService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  track(@Body() dto: EventDto) { return this.market.track(dto.visitorId, dto.productId, dto.kind); }

  /** Retirou o consentimento: apaga todo o histórico deste visitante. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('forget')
  @HttpCode(200)
  forget(@Body() dto: ForgetDto) { return this.market.forget(dto.visitorId); }
}
