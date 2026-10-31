import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Cifra segredos de terceiros guardados no banco (ex.: token do Melhor Envio do lojista).
 * Chave: SECRETS_KEY (32 bytes em base64). Sem ela, deriva do JWT_SECRET (trocar o JWT_SECRET invalida os tokens salvos).
 */
function key(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length === 32) return k;
  }
  const base = process.env.JWT_SECRET ?? 'dev-only-secret';
  return createHash('sha256').update(`balcao-secrets:${base}`).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = () => randomBytes(24).toString('base64url');

/** Assinatura curta (HMAC) para URLs: token do webhook por pedido e `state` do OAuth. */
export const sign = (scope: string, value: string) => createHmac('sha256', key()).update(`${scope}:${value}`).digest('base64url').slice(0, 32);
export function verifySigned(scope: string, value: string, sig: unknown): boolean {
  if (typeof sig !== 'string') return false;
  const a = Buffer.from(sign(scope, value)), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
