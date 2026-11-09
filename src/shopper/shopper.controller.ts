import { Body, Controller, Get, HttpCode, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ShopperService } from './shopper.service';
import { CurrentShopper, ShopperGuard } from './shopper.guard';
import { clearShopperCookie, setShopperCookie } from './shopper.cookie';
import { ShopperDeleteDto, ShopperEmailDto, ShopperLoginDto, ShopperPasswordDto, ShopperRegisterDto, ShopperResetDto, ShopperTokenDto, ShopperUpdateDto } from './dto/shopper.dto';
import type { ShopperDocument } from './schema/shopper.schema';

const MIN = 60_000;

/** Conta do comprador: a mesma em todas as lojas do Balcão. */
@Public()
@Controller('public/shopper')
export class ShopperController {
  constructor(private readonly shoppers: ShopperService, private readonly config: ConfigService) {}

  private open(res: Response, s: ShopperDocument) {
    setShopperCookie(res, this.config, this.shoppers.token(s));
    return this.shoppers.present(s);
  }

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 10 * MIN } })
  async register(@Body() dto: ShopperRegisterDto, @Res({ passthrough: true }) res: Response) {
    return this.open(res, await this.shoppers.register(dto));
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: MIN } })
  async login(@Body() dto: ShopperLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.open(res, await this.shoppers.login(dto.email, dto.password));
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    clearShopperCookie(res, this.config);
  }

  @Get('me')
  @UseGuards(ShopperGuard)
  me(@CurrentShopper() s: ShopperDocument) {
    return this.shoppers.present(s);
  }

  @Patch('me')
  @UseGuards(ShopperGuard)
  async update(@CurrentShopper() s: ShopperDocument, @Body() dto: ShopperUpdateDto) {
    return this.shoppers.present(await this.shoppers.update(s, dto));
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(ShopperGuard)
  @Throttle({ default: { limit: 5, ttl: MIN } })
  async password(@CurrentShopper() s: ShopperDocument, @Body() dto: ShopperPasswordDto, @Res({ passthrough: true }) res: Response) {
    return this.open(res, await this.shoppers.changePassword(s._id, dto.currentPassword, dto.password));
  }

  /** Sai de todos os aparelhos (inclusive este). */
  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(ShopperGuard)
  async logoutAll(@CurrentShopper() s: ShopperDocument, @Res({ passthrough: true }) res: Response) {
    await this.shoppers.revokeAll(s._id);
    clearShopperCookie(res, this.config);
  }

  /** Excluir a conta (pede a senha de novo). */
  @Post('delete')
  @HttpCode(204)
  @UseGuards(ShopperGuard)
  @Throttle({ default: { limit: 5, ttl: 10 * MIN } })
  async remove(@CurrentShopper() s: ShopperDocument, @Body() dto: ShopperDeleteDto, @Res({ passthrough: true }) res: Response) {
    await this.shoppers.deleteAccount(s._id, dto.password);
    clearShopperCookie(res, this.config);
  }

  @Post('verify/resend')
  @HttpCode(204)
  @UseGuards(ShopperGuard)
  @Throttle({ default: { limit: 3, ttl: 10 * MIN } })
  async resend(@CurrentShopper() s: ShopperDocument, @Body() body: { from?: string }) {
    await this.shoppers.resendVerify(s, typeof body?.from === 'string' ? body.from : undefined);
  }

  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: MIN } })
  async verify(@Body() dto: ShopperTokenDto) {
    await this.shoppers.verifyEmail(dto.token);
    return { ok: true };
  }

  @Post('forgot')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 10 * MIN } })
  async forgot(@Body() dto: ShopperEmailDto) {
    await this.shoppers.forgot(dto.email, dto.from);
  }

  @Post('reset')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: MIN } })
  async reset(@Body() dto: ShopperResetDto, @Res({ passthrough: true }) res: Response) {
    return this.open(res, await this.shoppers.reset(dto.token, dto.password));
  }
}
