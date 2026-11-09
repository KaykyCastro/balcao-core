import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { AuthChallenge } from './schema/challenge.schema';
import { MailService } from '../mail/mail.service';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
/** Teto de erros somando os reenvios: com ele, reenviar o código não dá mais chances de chute. */
export const MAX_WRONG_TOTAL = 10;
export const MAX_SENDS = 5;
export const RESEND_COOLDOWN_MS = 60_000;
export const TRUST_DAYS = 30;
export const CHALLENGE_RE = /^[a-f0-9]{64}$/;
export const CODE_RE = /^\d{6}$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** "kayky@gmail.com" -> "k***y@gmail.com": a pessoa reconhece o e-mail sem ele aparecer inteiro. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const u = user.length <= 2 ? `${user[0] ?? ''}***` : `${user[0]}***${user[user.length - 1]}`;
  return `${u}@${domain}`;
}

/** Segredo próprio para cada uso, derivado do JWT_SECRET: um token de "aparelho confiável" nunca vale como sessão. */
export function derivedSecret(jwtSecret: string, purpose: string): string {
  return createHmac('sha256', jwtSecret).update(`balcao:${purpose}`).digest('hex');
}

export interface ChallengeInfo { challenge: string; emailHint: string; expiresIn: number }
interface Subject { _id: unknown; email: string; tokenVersion?: number }

@Injectable()
export class TwoFactorService {
  constructor(
    @InjectModel(AuthChallenge.name) private readonly challenges: Model<AuthChallenge>,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get secret() { return this.config.getOrThrow<string>('JWT_SECRET'); }
  private hmac(idHash: string, code: string) { return createHmac('sha256', this.secret).update(`${idHash}:${code}`).digest('hex'); }
  private newCode() { return String(randomInt(0, 1_000_000)).padStart(6, '0'); }

  private async sendCode(email: string, code: string, purpose: 'login' | 'register') {
    const what = purpose === 'register' ? 'confirmar o e-mail da sua conta' : 'entrar no Balcão';
    await this.mail.send(email, `${code} é o seu código do Balcão`,
      `Use o código abaixo para ${what}:\n\n${code}\n\nEle vale por 10 minutos e só pode ser usado uma vez.\n\nSe não foi você que tentou entrar, troque sua senha agora: alguém sabe a senha atual.`);
  }

  /** Cria o desafio e envia o código. O identificador devolvido é opaco; o código só chega por e-mail. */
  async start(e: Subject, purpose: 'login' | 'register', client: 'web' | 'mobile'): Promise<ChallengeInfo> {
    const challenge = randomBytes(32).toString('hex');
    const idHash = sha256(challenge);
    const code = this.newCode();
    const now = new Date();
    await this.challenges.create({
      idHash, enterpriseId: new Types.ObjectId(String(e._id)), codeHash: this.hmac(idHash, code), purpose, client,
      lastSentAt: now, expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
    await this.sendCode(e.email, code, purpose);
    return { challenge, emailHint: maskEmail(e.email), expiresIn: CODE_TTL_MS / 1000 };
  }

  /**
   * Confere o código. Certo: apaga o desafio no mesmo passo (uso único) e devolve de quem é.
   * Errado: conta a tentativa; na 5ª (ou na 10ª somando os reenvios) o desafio é apagado e é preciso entrar com a senha de novo.
   */
  async verify(challenge: string, code: string, client: 'web' | 'mobile'): Promise<{ enterpriseId: string; purpose: 'login' | 'register' }> {
    if (!CHALLENGE_RE.test(challenge) || !CODE_RE.test(code)) throw new BadRequestException({ code: 'CODE_INVALID', message: 'Código incorreto' });
    const idHash = sha256(challenge);
    const c = await this.challenges.findOne({ idHash, client, expiresAt: { $gt: new Date() } });
    if (!c) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'O código expirou. Entre de novo para receber outro.' });

    const ok = timingSafeEqual(Buffer.from(this.hmac(idHash, code), 'hex'), Buffer.from(c.codeHash, 'hex'));
    if (!ok) {
      const after = await this.challenges.findOneAndUpdate({ _id: c._id }, { $inc: { attempts: 1, wrongTotal: 1 } }, { returnDocument: 'after' });
      const left = Math.min(MAX_ATTEMPTS - (after?.attempts ?? MAX_ATTEMPTS), MAX_WRONG_TOTAL - (after?.wrongTotal ?? MAX_WRONG_TOTAL));
      if (left <= 0) {
        await this.challenges.deleteOne({ _id: c._id });
        throw new HttpException({ statusCode: 429, code: 'CODE_LOCKED', message: 'Muitas tentativas com o código errado. Entre de novo para receber outro.' }, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new BadRequestException({ code: 'CODE_INVALID', message: `Código incorreto. ${left === 1 ? 'Resta 1 tentativa' : `Restam ${left} tentativas`}.` });
    }
    // Apagar condicionado ao hash certo: duas requisições simultâneas com o mesmo código não abrem duas sessões.
    const used = await this.challenges.findOneAndDelete({ _id: c._id, codeHash: c.codeHash });
    if (!used) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'O código expirou. Entre de novo para receber outro.' });
    return { enterpriseId: String(c.enterpriseId), purpose: c.purpose };
  }

  /** Novo código para o mesmo desafio (o anterior deixa de valer). Espera de 60 s entre envios, até 5 envios. */
  async resend(challenge: string, emailOf: (enterpriseId: string) => Promise<string | null>): Promise<ChallengeInfo> {
    if (!CHALLENGE_RE.test(challenge)) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'O código expirou. Entre de novo para receber outro.' });
    const idHash = sha256(challenge);
    const c = await this.challenges.findOne({ idHash, expiresAt: { $gt: new Date() } });
    if (!c) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'O código expirou. Entre de novo para receber outro.' });
    const wait = c.lastSentAt.getTime() + RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) throw new HttpException({ statusCode: 429, code: 'RESEND_WAIT', message: `Aguarde ${Math.ceil(wait / 1000)} s para pedir outro código.`, retryAfter: Math.ceil(wait / 1000) }, HttpStatus.TOO_MANY_REQUESTS);
    if (c.sends >= MAX_SENDS) throw new HttpException({ statusCode: 429, code: 'RESEND_LIMIT', message: 'Limite de envios atingido. Entre de novo mais tarde.' }, HttpStatus.TOO_MANY_REQUESTS);
    const email = await emailOf(String(c.enterpriseId));
    if (!email) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'O código expirou. Entre de novo para receber outro.' });
    const code = this.newCode();
    const now = new Date();
    await this.challenges.updateOne({ _id: c._id }, { $set: { codeHash: this.hmac(idHash, code), attempts: 0, lastSentAt: now, expiresAt: new Date(now.getTime() + CODE_TTL_MS) }, $inc: { sends: 1 } });
    await this.sendCode(email, code, c.purpose);
    return { challenge, emailHint: maskEmail(email), expiresIn: CODE_TTL_MS / 1000 };
  }

  // ---------------------------------------------------------------- aparelho confiável

  /** Token de "aparelho confiável" (30 dias). Assinado com segredo próprio e preso à versão da sessão (tv). */
  issueTrust(e: Subject): string {
    return this.jwt.sign({ sub: String(e._id), tv: e.tokenVersion ?? 0, typ: 'trust' }, { secret: derivedSecret(this.secret, 'trusted-device'), expiresIn: `${TRUST_DAYS}d`, algorithm: 'HS256' });
  }

  /** Vale só para a mesma empresa e enquanto ninguém trocou a senha nem usou "sair de todos". */
  isTrusted(token: string | null | undefined, e: Subject): boolean {
    if (!token || token.length > 2000) return false;
    try {
      const p = this.jwt.verify<{ sub: string; tv: number; typ: string }>(token, { secret: derivedSecret(this.secret, 'trusted-device'), algorithms: ['HS256'] });
      return p.typ === 'trust' && p.sub === String(e._id) && p.tv === (e.tokenVersion ?? 0);
    } catch {
      return false;
    }
  }
}
