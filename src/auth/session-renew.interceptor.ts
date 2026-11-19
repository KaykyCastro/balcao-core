import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { readCookie, SESSION_COOKIE, setSessionCookie } from './session-cookie';

/** Renova quando já passou 1/4 da vida do token (no máximo 1 dia): não regrava o cookie a cada requisição. */
export function shouldRenew(iat: number, exp: number, nowSec: number): boolean {
  const life = exp - iat;
  if (life <= 0 || nowSec >= exp) return false;
  return nowSec - iat >= Math.min(life / 4, 24 * 3600);
}

interface SessionClaims { sub: string; tv?: number; st?: string; stv?: number; iat?: number; exp?: number; typ?: string; ds?: string; adm?: string; br?: string; rtv?: number }

/**
 * Sessão deslizante do site: enquanto o lojista usa o painel, o cookie ganha um token novo com a MESMA duração do
 * original (30 dias do lojista, 8 h do admin/colaborador/tela do app). Sem isso a sessão vencia no prazo fixo do
 * login, mesmo com a pessoa usando. Só mexe em sessão por cookie que já passou pelos guards (token válido, versão
 * conferida); nunca na sessão de design do admin nem no Bearer do app. Roda antes do handler, então um handler que
 * troca ou apaga o cookie (sair, trocar senha) tem a palavra final.
 */
@Injectable()
export class SessionRenewInterceptor implements NestInterceptor {
  constructor(private readonly jwt: JwtService, private readonly config: ConfigService) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { user?: { _id?: unknown } }>();
    // A troca de loja (filiais) põe outra sessão no cookie: renovar a atual na mesma resposta mandaria dois cookies.
    if (!req.user?._id || req.headers['x-design-session'] || req.path.startsWith('/auth/logout') || /^\/branches\/[^/]+\/switch$/.test(req.path)) return next.handle();
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return next.handle();
    try {
      const c = this.jwt.decode<SessionClaims>(token);
      // O guard já validou este token (é o que está no cookie e não há cabeçalho de design); confere o dono por garantia.
      if (c && !c.typ && !c.ds && !c.adm && c.iat && c.exp && c.sub === String(req.user._id) && shouldRenew(c.iat, c.exp, Math.floor(Date.now() / 1000))) {
        const claims = { sub: c.sub, tv: c.tv ?? 0, ...(c.st ? { st: c.st, stv: c.stv ?? 0 } : {}), ...(c.br ? { br: c.br, rtv: c.rtv ?? 0 } : {}) };
        const fresh = this.jwt.sign(claims, { expiresIn: c.exp - c.iat });
        const exp = this.jwt.decode<{ exp: number }>(fresh).exp;
        setSessionCookie(ctx.switchToHttp().getResponse<Response>(), this.config, fresh, new Date(exp * 1000));
      }
    } catch { /* renovar é um extra: nunca derruba a requisição */ }
    return next.handle();
  }
}
