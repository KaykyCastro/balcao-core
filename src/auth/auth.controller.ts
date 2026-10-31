import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Request, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request as ExpressRequest, Response } from 'express';
import { IsIn, IsOptional } from 'class-validator';
import { HANDOFF_PATHS, isHandoffPath, type HandoffPath } from './mobile';
import { clearSessionCookie, setSessionCookie } from './session-cookie';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto } from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { EnterpriseService } from '../enterprise/enterprise.service';

const MIN = 60_000;

class HandoffDto {
  @IsOptional() @IsIn(HANDOFF_PATHS as unknown as string[])
  path?: HandoffPath;
}

@AllowWhenBlocked()
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService, private readonly enterprises: EnterpriseService, private readonly config: ConfigService) {}

  /** Grava o token num cookie httpOnly e devolve só os dados da empresa (o token nunca vai no corpo). */
  private start(res: Response, r: Awaited<ReturnType<AuthService['login']>>) {
    setSessionCookie(res, this.config, r.accessToken, r.expiresAt);
    return { enterprise: r.enterprise };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('login')
  @HttpCode(200)
  @UseGuards(LocalAuthGuard)
  async login(@Request() req, @Body() _dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.start(res, await this.authService.login(req.user));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * MIN } })
  @Post('register')
  async register(@Body() registerDto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    return this.start(res, await this.authService.register(registerDto));
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
  async me(@CurrentEnterprise() eid: string) {
    const e = await this.enterprises.findEnterpriseById(eid);
    return { id: String(e._id), ...e.toObject() };
  }

  @Throttle({ default: { limit: 5, ttl: 15 * MIN } })
  @Post('change-password')
  @HttpCode(200)
  async change(@CurrentEnterprise() eid: string, @Body() dto: ChangePasswordDto, @Res({ passthrough: true }) res: Response) {
    await this.enterprises.changePassword(eid, dto.currentPassword, dto.newPassword);
    clearSessionCookie(res, this.config);
    return { message: 'Senha alterada. Entre novamente.' };
  }

  /** "Sair de todos os dispositivos". */
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentEnterprise() eid: string, @Res({ passthrough: true }) res: Response) {
    await this.enterprises.revokeAllSessions(eid);
    clearSessionCookie(res, this.config);
    return { message: 'Todas as sessões foram encerradas.' };
  }

  // ---------------- App do celular ----------------
  // O app não usa cookie: recebe o token no corpo e manda "Authorization: Bearer". Sem cookie, não há CSRF.

  @Public()
  @Throttle({ default: { limit: 10, ttl: MIN } })
  @Post('mobile/login')
  @HttpCode(200)
  @UseGuards(LocalAuthGuard)
  async mobileLogin(@Request() req, @Body() _dto: LoginDto) {
    return this.authService.loginMobile(req.user);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * MIN } })
  @Post('mobile/register')
  async mobileRegister(@Body() dto: RegisterDto) {
    return this.authService.registerMobile(dto);
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
    const front = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, '');
    const r = await this.authService.redeemHandoff(code);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer'); // o código não vaza no Referer
    if (!r || !isHandoffPath(r.path)) return res.redirect(302, `${front}/entrar`);
    setSessionCookie(res, this.config, r.session.accessToken, r.session.expiresAt);
    return res.redirect(302, `${front}${r.path}?embed=app`);
  }
}
