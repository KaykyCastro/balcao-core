import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { derivedSecret } from './two-factor.service';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Para onde o app volta depois do Google: esquema do app.json. Vem só da configuração do servidor, nunca da requisição (sem redirecionamento aberto). */
export const DEFAULT_APP_RETURN_URL = 'balcao://google';
/** Desafio PKCE do app: base64url de sha256 (43 caracteres). */
export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

const b64url = (b: Buffer) => b.toString('base64url');
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface GoogleProfile { sub: string; email: string; name: string }
/** Estado guardado num cookie assinado entre a ida ao Google e a volta (10 min). */
export interface OAuthState { state: string; verifier: string; client: 'web' | 'mobile'; appChallenge?: string }

/**
 * Login com Google pelo servidor (authorization code + PKCE). O client secret nunca sai daqui.
 * O id_token chega direto do Google por TLS, autenticado pelo client secret; mesmo assim conferimos emissor,
 * destinatário, validade e e-mail confirmado.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);
  constructor(private readonly config: ConfigService, private readonly jwt: JwtService) {}

  get enabled(): boolean { return !!(this.config.get('GOOGLE_CLIENT_ID') && this.config.get('GOOGLE_CLIENT_SECRET')); }
  private get clientId() { return this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'); }
  private get secret() { return derivedSecret(this.config.getOrThrow<string>('JWT_SECRET'), 'google'); }
  get redirectUri(): string {
    const explicit = this.config.get<string>('GOOGLE_REDIRECT_URI');
    if (explicit) return explicit;
    return `${(this.config.get<string>('APP_URL') ?? 'http://localhost:2700').replace(/\/$/, '')}/auth/google/callback`;
  }

  /** No Expo Go o app responde em exp://IP:8081/--/google: defina APP_GOOGLE_RETURN_URL no .env de desenvolvimento. */
  get appReturnUrl(): string { return this.config.get<string>('APP_GOOGLE_RETURN_URL') || DEFAULT_APP_RETURN_URL; }

  private ensure() { if (!this.enabled) throw new ServiceUnavailableException({ code: 'GOOGLE_DISABLED', message: 'Login com Google indisponível no momento.' }); }

  /** Ida ao Google: devolve a URL e o estado (que vai num cookie httpOnly assinado). */
  begin(client: 'web' | 'mobile', appChallenge?: string): { url: string; cookie: string } {
    this.ensure();
    const st: OAuthState = { state: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)), client, ...(appChallenge ? { appChallenge } : {}) };
    const q = new URLSearchParams({
      client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: 'openid email profile',
      state: st.state, code_challenge: pkceChallenge(st.verifier), code_challenge_method: 'S256', prompt: 'select_account',
    });
    const cookie = this.jwt.sign({ ...st, typ: 'oauth' }, { secret: this.secret, expiresIn: '10m', algorithm: 'HS256' });
    return { url: `${AUTH_URL}?${q}`, cookie };
  }

  /** Volta do Google: confere o cookie de estado contra o "state" da URL. null = fluxo inválido ou vencido. */
  readState(cookie: string | null, state: unknown): OAuthState | null {
    if (!cookie || typeof state !== 'string') return null;
    try {
      const p = this.jwt.verify<OAuthState & { typ: string }>(cookie, { secret: this.secret, algorithms: ['HS256'] });
      return p.typ === 'oauth' && sameText(p.state, state) ? p : null;
    } catch {
      return null;
    }
  }

  /** Troca o código pelo perfil. Só aceita conta Google com e-mail confirmado. */
  async exchange(code: string, verifier: string): Promise<GoogleProfile> {
    this.ensure();
    let data: { id_token?: string } | null = null;
    try {
      const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: this.clientId, client_secret: this.config.getOrThrow('GOOGLE_CLIENT_SECRET'), redirect_uri: this.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
        signal: AbortSignal.timeout(10_000),
      });
      data = (await r.json().catch(() => null)) as { id_token?: string } | null;
      if (!r.ok) { this.logger.warn(`Google recusou a troca do código (${r.status})`); throw new UnauthorizedException('Não foi possível entrar com o Google'); }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      this.logger.error(`Falha ao falar com o Google: ${(e as Error).message}`);
      throw new ServiceUnavailableException('Google indisponível. Tente de novo.');
    }
    return this.profileFromIdToken(data?.id_token);
  }

  profileFromIdToken(idToken: string | undefined): GoogleProfile {
    const parts = idToken?.split('.');
    if (!parts || parts.length !== 3) throw new UnauthorizedException('Não foi possível entrar com o Google');
    let p: { iss?: string; aud?: string; exp?: number; sub?: string; email?: string; email_verified?: boolean | string; name?: string };
    try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new UnauthorizedException('Não foi possível entrar com o Google'); }
    const verified = p.email_verified === true || p.email_verified === 'true';
    if (!p.iss || !ISSUERS.includes(p.iss) || p.aud !== this.clientId || !p.exp || p.exp * 1000 < Date.now() || !p.sub || !p.email) {
      throw new UnauthorizedException('Não foi possível entrar com o Google');
    }
    if (!verified) throw new UnauthorizedException({ code: 'GOOGLE_EMAIL_UNVERIFIED', message: 'Confirme o e-mail da sua conta Google antes de usá-la aqui.' });
    return { sub: p.sub, email: p.email.trim().toLowerCase(), name: (p.name ?? '').slice(0, 120) };
  }

  // ---------------------------------------------------------------- tokens curtos de continuação

  /** Cadastro novo pelo Google: guarda o perfil por 30 min até a pessoa informar o nome da empresa e aceitar os termos. */
  signupToken(p: GoogleProfile, appChallenge?: string): string {
    return this.jwt.sign({ typ: 'gsignup', sub: p.sub, email: p.email, name: p.name, ...(appChallenge ? { ac: appChallenge } : {}) }, { secret: this.secret, expiresIn: '30m', algorithm: 'HS256' });
  }
  readSignupToken(token: string, verifier?: string): GoogleProfile {
    try {
      const p = this.jwt.verify<GoogleProfile & { typ: string; ac?: string }>(token, { secret: this.secret, algorithms: ['HS256'] });
      if (p.typ !== 'gsignup') throw new Error('typ');
      // Token do app: só vale com o verificador PKCE que ficou no aparelho (o link de volta pode ser interceptado).
      if (p.ac && (!verifier || !PKCE_VERIFIER_RE.test(verifier) || !sameText(pkceChallenge(verifier), p.ac))) throw new Error('pkce');
      if (!p.ac && verifier) throw new Error('client');
      return { sub: p.sub, email: p.email, name: p.name };
    } catch {
      throw new UnauthorizedException({ code: 'GOOGLE_SIGNUP_EXPIRED', message: 'O cadastro pelo Google expirou. Comece de novo.' });
    }
  }

  /** App: código de 2 min que o app troca pelo token, provando que é ele com o verificador PKCE. */
  mobileCode(enterpriseId: string, appChallenge: string): string {
    return this.jwt.sign({ typ: 'gmobile', sub: enterpriseId, ac: appChallenge }, { secret: this.secret, expiresIn: '2m', algorithm: 'HS256' });
  }
  readMobileCode(code: string, verifier: string): string {
    try {
      const p = this.jwt.verify<{ typ: string; sub: string; ac: string }>(code, { secret: this.secret, algorithms: ['HS256'] });
      if (p.typ !== 'gmobile' || !PKCE_VERIFIER_RE.test(verifier) || !sameText(pkceChallenge(verifier), p.ac)) throw new Error('pkce');
      return p.sub;
    } catch {
      throw new UnauthorizedException({ code: 'GOOGLE_CODE_INVALID', message: 'Não foi possível concluir o login com o Google. Tente de novo.' });
    }
  }
}
