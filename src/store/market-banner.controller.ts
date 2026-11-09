import { Controller, Get, Param, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { MarketBannerService } from './market-banner.service';

/** Carrosséis do marketplace (públicos). O admin gerencia em /admin/market-banners. */
@Public()
@Controller('public/market')
export class MarketBannerController {
  constructor(private readonly banners: MarketBannerService) {}

  @Get('banners')
  live() { return this.banners.live(); }

  @SkipThrottle()
  @Get('banners/:id/image')
  async image(@Param('id', ParseMongoIdPipe) id: string, @Res() res: Response) {
    const img = await this.banners.image(id);
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    if ('redirect' in img) return res.redirect(302, img.redirect);
    // O endereço muda (?v=) quando o banner é editado, então pode guardar em cache por muito tempo.
    res.set({ 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.send(img.data);
  }
}
