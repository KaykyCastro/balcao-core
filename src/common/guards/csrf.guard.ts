import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readCookie, SESSION_COOKIE } from '../../auth/session-cookie';
import { SHOPPER_COOKIE } from '../../shopper/shopper.cookie';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'erp-web';

/**
 * Proteção CSRF para quem usa cookie de sessão (lojista ou comprador). Em requisições que alteram dados:
 *  1) exige o cabeçalho X-Requested-With (um formulário/<img> de outro site não consegue enviá-lo, e o CORS barra o preflight);
 *  2) se vier Origin e CORS_ORIGIN estiver definido, a origem precisa estar na lista ou ser o próprio endereço que recebeu
 *     (loja no domínio próprio chamando /api no mesmo domínio).
 * Sem cookie de sessão (login, cadastro, webhook, integrações com Bearer) não há o que forjar, então passa.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly origins: string[];
  constructor(config: ConfigService) {
    this.origins = (config.get<string>('CORS_ORIGIN') ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  }
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (SAFE.has(String(req.method).toUpperCase())) return true;
    if (!readCookie(req, SESSION_COOKIE) && !readCookie(req, SHOPPER_COOKIE)) return true;
    if (req.headers?.[CSRF_HEADER] !== CSRF_VALUE) throw new ForbiddenException({ statusCode: 403, code: 'CSRF', message: 'Requisição recusada' });
    const origin = req.headers?.origin as string | undefined;
    // Mesma origem (a loja no domínio próprio chama /api no mesmo domínio; o servidor repassa mantendo o Host): pode.
    // Um site de fora manda o Origin dele, diferente do Host, e continua barrado.
    const sameOrigin = !!origin && !!req.headers?.host && origin.replace(/\/$/, '').replace(/^https?:\/\//, '').toLowerCase() === String(req.headers.host).toLowerCase();
    if (origin && !sameOrigin && this.origins.length && !this.origins.includes(origin.replace(/\/$/, ''))) {
      throw new ForbiddenException({ statusCode: 403, code: 'CSRF', message: 'Origem não permitida' });
    }
    return true;
  }
}
