import { LEGAL_VERSIONS } from '../common/legal-versions';
import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthHandoff } from './schema/handoff.schema';
import { HANDOFF_CODE_RE, HANDOFF_TTL_MS, type HandoffPath } from './mobile';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';

import { RegisterDto } from './dto/register.dto';
import { DUMMY_HASH, EnterpriseService } from '../enterprise/enterprise.service';
import { EnterpriseDocument } from '../enterprise/schema/enterprise.schema';
import { MailService } from '../mail/mail.service';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly enterpriseService: EnterpriseService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    @InjectModel(AuthHandoff.name) private readonly handoffs: Model<AuthHandoff>,
  ) {}

  /** Cadastro (site e app): cria a conta; a sessão só abre depois do código que confirma o e-mail. Lança 409 se já existir. */
  createAccount(dto: RegisterDto): Promise<EnterpriseDocument> {
    return this.enterpriseService.create(dto, this.terms(dto));
  }

  /** Cadastro pelo Google: e-mail e identidade vêm do Google (já confirmados); a pessoa informa a empresa e aceita os termos. */
  createGoogleAccount(p: { sub: string; email: string }, dto: { name: string; cnpj?: string; termsVersion?: string; privacyVersion?: string }): Promise<EnterpriseDocument> {
    return this.enterpriseService.createWithGoogle({ name: dto.name.trim(), email: p.email, googleId: p.sub, cnpj: dto.cnpj }, this.terms(dto));
  }

  /**
   * Versão aceita no cadastro: sempre a vigente (common/legal-versions.ts). Os links do cadastro, no site e no app, abrem
   * os textos atuais, então é ela que foi aceita; a data mandada pelo cliente não vale como prova (o app chegou a mandar
   * uma que nunca existiu).
   */
  private terms(_dto?: { termsVersion?: string; privacyVersion?: string }) {
    return { version: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy };
  }

  /**
   * null (-> 401) para e-mail inexistente ou senha errada, sempre gastando o mesmo tempo.
   * 5 erros seguidos travam a conta por 15 min (429). Conta suspensa só é revelada com a senha certa.
   */
  async validate(email: string, password: string): Promise<EnterpriseDocument | null> {
    const e = await this.enterpriseService.findByEmailForLogin(email);
    if (!e) {
      await bcrypt.compare(password, DUMMY_HASH);
      return null;
    }
    if (e.lockUntil && e.lockUntil > new Date()) {
      throw new HttpException({ statusCode: 429, code: 'LOGIN_LOCKED', message: 'Muitas tentativas. Tente de novo em alguns minutos.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await bcrypt.compare(password, e.password))) {
      await this.enterpriseService.registerLoginFailure(String(e._id), MAX_FAILURES, LOCK_MS);
      return null;
    }
    if (e.status === 'suspended') {
      throw new ForbiddenException({ statusCode: 403, code: 'ACCOUNT_SUSPENDED', message: 'Conta suspensa. Fale com o suporte.' });
    }
    await this.enterpriseService.registerLoginSuccess(String(e._id));
    return e;
  }

  async login(enterprise: EnterpriseDocument, opts: { expiresIn?: string } = {}) {
    const tv = (enterprise as unknown as { tokenVersion?: number }).tokenVersion ?? 0;
    const payload = { sub: String(enterprise._id), tv };
    const { _id, ...safe } = enterprise.toObject() as unknown as Record<string, unknown> & { _id: unknown };
    const accessToken = opts.expiresIn ? this.jwtService.sign(payload, { expiresIn: opts.expiresIn as any }) : this.jwtService.sign(payload);
    const exp = (this.jwtService.decode(accessToken) as { exp?: number } | null)?.exp;
    const expiresAt = new Date(exp ? exp * 1000 : Date.now() + 8 * 3600_000);
    return { accessToken, expiresAt, enterprise: { id: String(_id), ...safe } };
  }

  /** Login do funcionário: mesma sessão da empresa, marcada com o funcionário (st) e a versão do login dele (stv). */
  loginStaff(r: { enterpriseId: string; enterpriseTv: number; staff: { _id: unknown; tokenVersion?: number; name: string; role: string; permissions: string[] } }, opts: { expiresIn?: string } = {}) {
    const payload = { sub: r.enterpriseId, tv: r.enterpriseTv, st: String(r.staff._id), stv: r.staff.tokenVersion ?? 0 };
    const accessToken = opts.expiresIn ? this.jwtService.sign(payload, { expiresIn: opts.expiresIn as any }) : this.jwtService.sign(payload);
    const exp = (this.jwtService.decode(accessToken) as { exp?: number } | null)?.exp;
    return { accessToken, expiresAt: new Date(exp ? exp * 1000 : Date.now() + 8 * 3600_000) };
  }

  /**
   * App do celular: o token vai no corpo (o app guarda no armazenamento seguro do aparelho) e dura mais
   * (JWT_MOBILE_EXPIRES_IN, padrão 30 dias). "Sair de todos os dispositivos" e troca de senha continuam derrubando.
   */
  loginMobile(enterprise: EnterpriseDocument) {
    return this.login(enterprise, { expiresIn: this.config.get<string>('JWT_MOBILE_EXPIRES_IN') ?? '30d' });
  }

  /** Cria um código de uso único (vale 60 s) para abrir uma tela do Balcão já logado no navegador do app. */
  async createHandoff(enterpriseId: string, path: HandoffPath): Promise<string> {
    const code = randomBytes(32).toString('hex');
    await this.handoffs.create({ codeHash: sha256(code), enterpriseId: new Types.ObjectId(enterpriseId), path, expiresAt: new Date(Date.now() + HANDOFF_TTL_MS) });
    return code;
  }

  /** Troca o código por uma sessão normal (cookie). Apaga o código no mesmo passo: não dá para usar duas vezes. */
  async redeemHandoff(code: string) {
    if (!HANDOFF_CODE_RE.test(code)) return null;
    const h = await this.handoffs.findOneAndDelete({ codeHash: sha256(code), expiresAt: { $gt: new Date() } });
    if (!h) return null;
    const e = await this.enterpriseService.findEnterpriseById(String(h.enterpriseId)).catch(() => null);
    if (!e || e.status === 'suspended') return null;
    return { session: await this.login(e), path: h.path };
  }

  /** Resposta sempre igual: não revela se o e-mail existe. O link só chega por e-mail. */
  async forgotPassword(email: string): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const e = await this.enterpriseService.setResetToken(email, sha256(token), new Date(Date.now() + RESET_TTL_MS));
    if (!e) return;
    const base = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, '');
    await this.mail.send(e.email, 'Redefinição de senha', `Para criar uma nova senha, abra o link (vale por 1 hora):\n\n${base}/redefinir/${token}\n\nSe não foi você, ignore este e-mail.`);
  }

  async resetPassword(token: string, password: string): Promise<boolean> {
    return this.enterpriseService.resetPasswordByHash(sha256(token), password);
  }
}
