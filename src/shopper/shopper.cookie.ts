import type { Response } from 'express';
import type { ConfigService } from '@nestjs/config';
import { baseOptions } from '../auth/session-cookie';

/** Cookie da conta do comprador. Separado do cookie do lojista: um não serve para o outro. */
export const SHOPPER_COOKIE = 'balcao_shopper';
export const SHOPPER_SESSION_DAYS = 30;

export function setShopperCookie(res: Response, config: Pick<ConfigService, 'get'>, token: string) {
  res.cookie(SHOPPER_COOKIE, token, { ...baseOptions(config), expires: new Date(Date.now() + SHOPPER_SESSION_DAYS * 86_400_000) });
}
export function clearShopperCookie(res: Response, config: Pick<ConfigService, 'get'>) {
  res.clearCookie(SHOPPER_COOKIE, baseOptions(config));
}
