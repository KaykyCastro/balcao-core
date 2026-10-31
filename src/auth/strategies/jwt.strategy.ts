import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { jwtFromCookieOrBearer } from '../session-cookie';
import { ConfigService } from '@nestjs/config';
import { EnterpriseService } from '../../enterprise/enterprise.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private readonly enterpriseService: EnterpriseService) {
    super({
      jwtFromRequest: jwtFromCookieOrBearer,
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow('JWT_SECRET'),
      algorithms: ['HS256'], // sem isso, o passport-jwt aceita qualquer algoritmo da família do segredo
    });
  }

  /** Carrega a empresa a cada request: bloqueio, suspensão, papel e versão do token chegam sempre atualizados. */
  async validate(payload: { sub: string; tv?: number }) {
    const enterprise = await this.enterpriseService.findForAuth(payload.sub);
    if (!enterprise) throw new UnauthorizedException();
    if ((enterprise as unknown as { tokenVersion?: number }).tokenVersion !== (payload.tv ?? 0)) throw new UnauthorizedException('Sessão encerrada. Entre novamente.');
    if (enterprise.status === 'suspended') throw new ForbiddenException({ statusCode: 403, code: 'ACCOUNT_SUSPENDED', message: 'Conta suspensa. Fale com o suporte.' });
    return enterprise;
  }
}
