import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Req, Request, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request as ExpressRequest, Response } from 'express';
import { IsIn, IsOptional } from 'class-validator';
import { HANDOFF_PATHS, isHandoffPath, type HandoffPath } from './mobile';
import { clearOAuthCookie, clearSessionCookie, OAUTH_COOKIE, readCookie, setOAuthCookie, setSessionCookie, setTrustCookie, TRUST_COOKIE } from './session-cookie';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto, ForgotPasswordDto, GoogleCompleteDto, GoogleStartQuery, MobileGoogleExchangeDto, ResendCodeDto, ResetPasswordDto, VerifyCodeDto } from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { EnterpriseService } from '../enterprise/enterprise.service';
import type { EnterpriseDocument } from '../enterprise/schema/enterprise.schema';
import { StaffService } from '../staff/staff.service';
import { StaffLoginDto } from '../staff/dto/staff.dto';
import { UnauthorizedException } from '@nestjs/common';
import { LEGAL_VERSIONS } from '../common/legal-versions';
import { TRUST_DAYS, TwoFactorService, type ChallengeInfo } from './two-factor.service';
import { GoogleService, type GoogleProfile } from './google.service';

const MIN = 60_000;

class AcceptTermsDto {
  @IsIn([LEGAL_VERSIONS.terms])
  termsVersion: string;

  @IsIn([LEGAL_VERSIONS.privacy])
  privacyVersion: string;
}

class HandoffDto {
  @IsOptional() @IsIn(HANDOFF_PATHS as unknown as string[])
  path?: HandoffPath;
}

/** Resposta quando falta o código enviado por e-mail (o cliente mostra a tela do código). */
type TwoFactorPending = { twoFactor: true } & ChallengeInfo;
const pending = (c: ChallengeInfo): TwoFactorPending => ({ twoFactor: true, ...c });
const tv = (e: EnterpriseDocument) => (e as unknown as { tokenVersion?: number }).tokenVersion ?? 0;

@AllowWhenBlocked()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly enterprises: EnterpriseService,
    private readonly config: ConfigService,
    private readonly staff: StaffService,
    private readonly twoFactor?: TwoFactorService,
    private readonly google?: GoogleService,
  ) {}

  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, ''); }

  /** Grava o token num cookie httpOnly e devolve só os dados da empresa (o token nunca vai no corpo). */
  private start(res: Response, r: Awaited<ReturnType<AuthService['login']>>) {
    setSessionCookie(res, this.config, r.accessToken, r.expiresAt);
    return { enterprise: r.enterprise };
  }

  /**
   * Depois da senha certa: aparelho confiável (e não admin) entra direto; senão vai o código por e-mail.
   * Admin sempre confirma com o código.
   */
  private needsCode(e: EnterpriseDocument, trustToken: string | null | undefined) {
    return e.role === 'admin' || !this.twoFactor!.isTrusted(trustToken, { _id: e._id, email: e.email, tokenVersion: tv(e) });
  }

  private async loadForSession(enterpriseId: string): Promise<EnterpriseDocument> {
    const e = await this.enterprises.findForAuth(enterpriseId);
    if (!e) throw new UnauthorizedException('Sessão encerrada. Entre novamente.');
    if (e.status === 'suspended') throw new ForbiddenException({ statusCode: 403, code: 'ACCOUNT_SUSPENDED', message: 'Conta suspensa. Fale com o suporte.' });
    return e;
  }

  /** Quais formas de entrar estão ligadas (o botão do Google só aparece com as chaves configuradas). */
  @Public()
  @Get('providers')
  providers() {
    return { google: !!this.google?.enabled };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('login')
  @HttpCode(200)
  @UseGuards(LocalAuthGuard)
  async login(@Request() req: ExpressRequest & { user: EnterpriseDocument }, @Body() _dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const e = req.user;
    if (this.needsCode(e, readCookie(req, TRUST_COOKIE))) return pending(await this.twoFactor!.start(e, 'login', 'web'));
    return this.start(res, await this.authService.login(e));
  }

  /** Segunda etapa: o código de 6 dígitos que chegou por e-mail. Certo = sessão aberta (e e-mail confirmado). */
  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('login/verify')
  @HttpCode(200)
  async verify(@Body() dto: VerifyCodeDto, @Res({ passthrough: true }) res: Response) {
    const { enterpriseId } = await this.twoFactor!.verify(dto.challenge, dto.code, 'web');
    const e = await this.loadForSession(enterpriseId);
    await this.enterprises.markEmailVerified(enterpriseId);
    await this.enterprises.registerLoginSuccess(enterpriseId);
    if (dto.trustDevice && e.role !== 'admin') setTrustCookie(res, this.config, this.twoFactor!.issueTrust({ _id: e._id, email: e.email, tokenVersion: tv(e) }), TRUST_DAYS);
    return this.start(res, await this.authService.login(e));
  }

  /** Outro código para o mesmo desafio (site e app). Espera de 60 s entre pedidos. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 15 * MIN } })
  @Post('login/resend')
  @HttpCode(200)
  async resend(@Body() dto: ResendCodeDto) {
    return pending(await this.twoFactor!.resend(dto.challenge, async (id) => (await this.enterprises.findForAuth(id))?.email ?? null));
  }

  /** Funcionário: código da empresa + usuário + senha (criados pelo dono em Colaboradores). Sem e-mail, sem segunda etapa. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('staff/login')
  @HttpCode(200)
  async staffLogin(@Body() dto: StaffLoginDto, @Req() req: ExpressRequest, @Res({ passthrough: true }) res: Response) {
    const r = await this.staff.validateLogin(dto.code, dto.username, dto.password, { ip: req.ip, device: String(req.headers['user-agent'] ?? '') });
    if (!r) throw new UnauthorizedException('Código, usuário ou senha inválidos');
    const s = this.authService.loginStaff(r);
    setSessionCookie(res, this.config, s.accessToken, s.expiresAt);
    const e = await this.enterprises.findEnterpriseById(r.enterpriseId);
    return { enterprise: { id: String(e._id), ...e.toObject() }, staff: { id: String(r.staff._id), name: r.staff.name, role: r.staff.role, permissions: r.staff.permissions } };
  }

  /** Cadastro: cria a conta e manda o código para confirmar o e-mail. A sessão só abre com o código. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * MIN } })
  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    const e = await this.authService.createAccount(registerDto);
    return pending(await this.twoFactor!.start(e, 'register', 'web'));
  }

  /** Encerra a sessão deste navegador (apaga o cookie). Pública: funciona mesmo com a sessão já vencida. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    clearSessionCookie(res, this.config);
    return { message: 'Sessão encerrada.' };
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 15 * MIN } })
  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
    return { message: 'Se o e-mail estiver cadastrado, enviamos o link de redefinição.' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * MIN } })
  @Post('reset-password')
  @HttpCode(200)
  async reset(@Body() dto: ResetPasswordDto) {
    if (!(await this.authService.resetPassword(dto.token, dto.password))) throw new BadRequestException('Link inválido ou expirado');
    return { message: 'Senha redefinida.' };
  }

  /** Dados da empresa logada (inclui papel, teste grátis e bloqueio). Funciona com a conta bloqueada. */
  @Get('me')
  async me(@CurrentEnterprise() eid: string, @Req() req: { user: { staff?: unknown } }) {
    const e = await this.enterprises.findEnterpriseById(eid);
    return { id: String(e._id), ...e.toObject(), ...(req.user.staff ? { staff: req.user.staff } : {}) };
  }

  /** Novo aceite quando os Termos ou a Política de Privacidade mudam de versão (fica a data como prova). */
  @Post('accept-terms')
  @HttpCode(200)
  async acceptTerms(@CurrentEnterprise() eid: string, @Body() dto: AcceptTermsDto) {
    const e = await this.enterprises.acceptTerms(eid, dto.termsVersion, dto.privacyVersion);
    return { termsVersion: e.termsVersion, privacyVersion: e.privacyVersion, termsAcceptedAt: e.termsAcceptedAt };
  }

  @Throttle({ default: { limit: 5, ttl: 15 * MIN } })
  @Post('change-password')
  @HttpCode(200)
  async change(@CurrentEnterprise() eid: string, @Body() dto: ChangePasswordDto, @Res({ passthrough: true }) res: Response) {
    await this.enterprises.changePassword(eid, dto.currentPassword, dto.newPassword);
    clearSessionCookie(res, this.config);
    return { message: 'Senha alterada. Entre novamente.' };
  }

  /** "Sair de todos os dispositivos" (também revoga os aparelhos confiáveis: eles dependem da versão da sessão). */
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentEnterprise() eid: string, @Res({ passthrough: true }) res: Response) {
    await this.enterprises.revokeAllSessions(eid);
    clearSessionCookie(res, this.config);
    return { message: 'Todas as sessões foram encerradas.' };
  }

  // ---------------- Login com Google ----------------

  /** Ida ao Google. Site: link normal. App: abre no navegador do sistema com o desafio PKCE do app. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: MIN } })
  @Get('google')
  googleStart(@Query() q: GoogleStartQuery, @Res() res: Response) {
    const client = q.client ?? 'web';
    if (client === 'mobile' && !q.challenge) throw new BadRequestException('Requisição inválida');
    const { url, cookie } = this.google!.begin(client, client === 'mobile' ? q.challenge : undefined);
    setOAuthCookie(res, this.config, cookie);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, url);
  }

  /** Volta do Google. Conta existente: entra. Conta nova: pede nome da empresa e aceite dos termos. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: MIN } })
  @Get('google/callback')
  async googleCallback(@Query('code') code: unknown, @Query('state') state: unknown, @Query('error') error: unknown, @Req() req: ExpressRequest, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const st = this.google!.readState(readCookie(req, OAUTH_COOKIE), state);
    clearOAuthCookie(res, this.config);
    const fail = (reason: string) => res.redirect(302, st?.client === 'mobile' ? `${this.google!.appReturnUrl}?erro=${reason}` : `${this.front}/entrar?erro=${reason}`);
    if (!st) return fail('google');
    if (error || typeof code !== 'string' || code.length > 2000) return fail(error === 'access_denied' ? 'google-cancelado' : 'google');

    let profile: GoogleProfile;
    try { profile = await this.google!.exchange(code, st.verifier); }
    catch (e) { return fail((e as { response?: { code?: string } }).response?.code === 'GOOGLE_EMAIL_UNVERIFIED' ? 'google-email' : 'google'); }

    let ent = await this.enterprises.findByGoogleId(profile.sub);
    if (!ent) {
      const byEmail = await this.enterprises.findByEmail(profile.email);
      if (byEmail) {
        if (byEmail.role === 'admin') return fail('google-admin');
        try { ent = await this.enterprises.linkGoogle(byEmail, profile.sub); } catch { return fail('google-vinculado'); }
      }
    }
    if (!ent) {
      // Conta nova: o perfil segue num token curto. No site vai no fragmento (#), que não chega a servidores nem logs.
      const t = this.google!.signupToken(profile, st.appChallenge);
      return res.redirect(302, st.client === 'mobile' ? `${this.google!.appReturnUrl}?cadastro=${encodeURIComponent(t)}` : `${this.front}/registrar/google#t=${encodeURIComponent(t)}`);
    }
    if (ent.role === 'admin') return fail('google-admin'); // admin entra só com senha + código
    if (ent.status === 'suspended') return fail('suspensa');

    await this.enterprises.registerLoginSuccess(String(ent._id));
    await this.enterprises.markEmailVerified(String(ent._id));
    if (st.client === 'mobile') return res.redirect(302, `${this.google!.appReturnUrl}?code=${encodeURIComponent(this.google!.mobileCode(String(ent._id), st.appChallenge!))}`);
    const s = await this.authService.login(ent);
    setSessionCookie(res, this.config, s.accessToken, s.expiresAt);
    return res.redirect(302, `${this.front}/app`);
  }

  /** Site: conclui o cadastro pelo Google (nome da empresa + termos). O e-mail já vem confirmado pelo Google. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * MIN } })
  @Post('google/complete')
  async googleComplete(@Body() dto: GoogleCompleteDto, @Res({ passthrough: true }) res: Response) {
    if (dto.verifier) throw new BadRequestException('Requisição inválida');
    const e = await this.authService.createGoogleAccount(this.google!.readSignupToken(dto.token), dto);
    return this.start(res, await this.authService.login(e));
  }

  // ---------------- App do celular ----------------
  // O app não usa cookie: recebe o token no corpo e manda "Authorization: Bearer". Sem cookie, não há CSRF.

  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('mobile/login')
  @HttpCode(200)
  @UseGuards(LocalAuthGuard)
  async mobileLogin(@Request() req: { user: EnterpriseDocument }, @Body() dto: LoginDto) {
    const e = req.user;
    if (this.needsCode(e, dto.deviceToken)) return pending(await this.twoFactor!.start(e, 'login', 'mobile'));
    return this.authService.loginMobile(e);
  }

  /**
   * App: colaborador entra com código da loja + usuário + senha (os mesmos da web) e recebe o token no corpo.
   * Vale JWT_STAFF_MOBILE_EXPIRES_IN (padrão 7 dias); o dono derruba quando quiser (desativar, trocar a senha ou
   * "desconectar" o colaborador). Horário de acesso e turno continuam valendo em cada pedido (StaffGuard).
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('mobile/staff/login')
  @HttpCode(200)
  async mobileStaffLogin(@Body() dto: StaffLoginDto, @Req() req: ExpressRequest) {
    const r = await this.staff.validateLogin(dto.code, dto.username, dto.password, { ip: req.ip, device: `app ${String(req.headers['user-agent'] ?? '')}`.trim() });
    if (!r) throw new UnauthorizedException('Código, usuário ou senha inválidos');
    const s = this.authService.loginStaff(r, { expiresIn: this.config.get<string>('JWT_STAFF_MOBILE_EXPIRES_IN') ?? '7d' });
    const e = await this.enterprises.findEnterpriseById(r.enterpriseId);
    // O mesmo retrato que /auth/me devolve (permissões, turno aberto, fora do horário).
    const st = await this.staff.forAuth(r.enterpriseId, String(r.staff._id), r.staff.tokenVersion ?? 0);
    return { accessToken: s.accessToken, expiresAt: s.expiresAt, enterprise: { id: String(e._id), ...e.toObject(), staff: st } };
  }

  /** App: segunda etapa. Com "confiar neste aparelho", devolve também o deviceToken para o app guardar. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('mobile/login/verify')
  @HttpCode(200)
  async mobileVerify(@Body() dto: VerifyCodeDto) {
    const { enterpriseId } = await this.twoFactor!.verify(dto.challenge, dto.code, 'mobile');
    const e = await this.loadForSession(enterpriseId);
    await this.enterprises.markEmailVerified(enterpriseId);
    await this.enterprises.registerLoginSuccess(enterpriseId);
    const session = await this.authService.loginMobile(e);
    const deviceToken = dto.trustDevice && e.role !== 'admin' ? this.twoFactor!.issueTrust({ _id: e._id, email: e.email, tokenVersion: tv(e) }) : undefined;
    return { ...session, ...(deviceToken ? { deviceToken } : {}) };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * MIN } })
  @Post('mobile/register')
  async mobileRegister(@Body() dto: RegisterDto) {
    const e = await this.authService.createAccount(dto);
    return pending(await this.twoFactor!.start(e, 'register', 'mobile'));
  }

  /** App: troca o código de volta do Google pelo token, provando com o verificador PKCE que ficou no aparelho. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('mobile/google/exchange')
  @HttpCode(200)
  async mobileGoogleExchange(@Body() dto: MobileGoogleExchangeDto) {
    const e = await this.loadForSession(this.google!.readMobileCode(dto.code, dto.verifier));
    if (e.role === 'admin') throw new ForbiddenException('Administradores entram com e-mail e senha.');
    return this.authService.loginMobile(e);
  }

  /** App: conclui o cadastro pelo Google. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * MIN } })
  @Post('mobile/google/complete')
  async mobileGoogleComplete(@Body() dto: GoogleCompleteDto) {
    if (!dto.verifier) throw new BadRequestException('Requisição inválida');
    const e = await this.authService.createGoogleAccount(this.google!.readSignupToken(dto.token, dto.verifier), dto);
    return this.authService.loginMobile(e);
  }

  /** O app pede um link de uso único para abrir a tela de vendas já logado no navegador embutido. */
  @Throttle({ default: { limit: 20, ttl: MIN } })
  @Post('mobile/handoff')
  @HttpCode(200)
  async handoff(@CurrentEnterprise() eid: string, @Body() dto: HandoffDto, @Req() req: ExpressRequest) {
    const code = await this.authService.createHandoff(eid, dto.path ?? '/app/vendas');
    const api = (this.config.get<string>('APP_URL') || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    return { url: `${api}/auth/handoff/${code}` };
  }

  /** Abre a sessão (cookie) a partir do código e leva à tela pedida, em modo embutido. Código inválido: tela de login. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: MIN } })
  @Get('handoff/:code')
  async redeem(@Param('code') code: string, @Res() res: Response) {
    const r = await this.authService.redeemHandoff(code);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer'); // o código não vaza no Referer
    if (!r || !isHandoffPath(r.path)) return res.redirect(302, `${this.front}/entrar`);
    setSessionCookie(res, this.config, r.session.accessToken, r.session.expiresAt);
    return res.redirect(302, `${this.front}${r.path}?embed=app`);
  }
}
