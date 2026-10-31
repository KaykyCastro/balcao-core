import type { Request, Response, CookieOptions } from 'express';
import type { ConfigService } from '@nestjs/config';

/** Cookie da sessão: httpOnly (o JavaScript da página nunca enxerga o token). */
export const SESSION_COOKIE = 'erp_session';

export function readCookie(req: Pick<Request, 'headers'>, name: string): string | null {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** Extrator do passport-jwt: cookie primeiro; Authorization: Bearer continua valendo para integrações. */
export const jwtFromCookieOrBearer = (req: Request): string | null => {
  const c = readCookie(req, SESSION_COOKIE);
  if (c) return c;
  const h = req.headers?.authorization;
  return h && /^Bearer\s+\S+$/i.test(h) ? h.split(/\s+/)[1] : null;
};

function baseOptions(config: Pick<ConfigService, 'get'>): CookieOptions {
  const prod = config.get('NODE_ENV') === 'production';
  const same = String(config.get('COOKIE_SAMESITE') ?? 'lax').toLowerCase();
  const sameSite = same === 'none' || same === 'strict' ? same : 'lax';
  const domain = config.get<string>('COOKIE_DOMAIN') || undefined;
  // SameSite=None só funciona com Secure; em produção o cookie é sempre Secure.
  return { httpOnly: true, secure: prod || sameSite === 'none', sameSite, path: '/', ...(domain ? { domain } : {}) };
}

export function setSessionCookie(res: Response, config: Pick<ConfigService, 'get'>, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, { ...baseOptions(config), expires: expiresAt });
}
export function clearSessionCookie(res: Response, config: Pick<ConfigService, 'get'>) {
  res.clearCookie(SESSION_COOKIE, baseOptions(config));
}
