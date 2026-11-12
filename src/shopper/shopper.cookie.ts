import type { Response } from 'express';
import type { ConfigService } from '@nestjs/config';
import { baseOptions } from '../auth/session-cookie';

/** Cookie da conta do comprador. Separado do cookie do lojista: um não serve para o outro. */
export const SHOPPER_COOKIE = 'balcao_shopper';
export const SHOPPER_SESSION_DAYS = 30;

/**
 * Opções do cookie para ESTE pedido: o COOKIE_DOMAIN (ex.: usebalcao.com) só vale quando o pedido chegou por um endereço
 * dele. Na loja com domínio próprio (minhaloja.com.br/api), o cookie fica no domínio da loja; com o COOKIE_DOMAIN da
 * plataforma o navegador recusaria o cookie e o comprador não conseguiria entrar.
 */
function optionsFor(res: Response, config: Pick<ConfigService, 'get'>) {
  const o = baseOptions(config);
  const host = String(res.req?.headers?.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const d = String(o.domain ?? '').toLowerCase().replace(/^\./, '');
  if (d && host && host !== d && !host.endsWith(`.${d}`)) { const { domain: _skip, ...rest } = o; return rest; }
  return o;
}
export function setShopperCookie(res: Response, config: Pick<ConfigService, 'get'>, token: string) {
  res.cookie(SHOPPER_COOKIE, token, { ...optionsFor(res, config), expires: new Date(Date.now() + SHOPPER_SESSION_DAYS * 86_400_000) });
}
export function clearShopperCookie(res: Response, config: Pick<ConfigService, 'get'>) {
  res.clearCookie(SHOPPER_COOKIE, optionsFor(res, config));
}
