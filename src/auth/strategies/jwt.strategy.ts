import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { jwtFromCookieOrBearer } from '../session-cookie';
import { ConfigService } from '@nestjs/config';
import { EnterpriseService } from '../../enterprise/enterprise.service';
import { StaffService } from '../../staff/staff.service';
import { DesignService } from '../../design/design.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private readonly enterpriseService: EnterpriseService, private readonly staffService: StaffService, private readonly design: DesignService) {
    super({
      jwtFromRequest: jwtFromCookieOrBearer,
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow('JWT_SECRET'),
      algorithms: ['HS256'], // sem isso, o passport-jwt aceita qualquer algoritmo da família do segredo
    });
  }

  /** Carrega a empresa a cada request: bloqueio, suspensão, papel e versão do token chegam sempre atualizados. */
  async validate(payload: { sub: string; tv?: number; st?: string; stv?: number; typ?: string; ds?: string; adm?: string }) {
    // Tokens auxiliares (aparelho confiável, Google) usam segredos próprios e têm "typ"; nunca valem como sessão.
    if (payload.typ) throw new UnauthorizedException();
    const enterprise = await this.enterpriseService.findForAuth(payload.sub);
    if (!enterprise) throw new UnauthorizedException();
    if ((enterprise as unknown as { tokenVersion?: number }).tokenVersion !== (payload.tv ?? 0)) throw new UnauthorizedException('Sessão encerrada. Entre novamente.');
    if (enterprise.status === 'suspended') throw new ForbiddenException({ statusCode: 403, code: 'ACCOUNT_SUSPENDED', message: 'Conta suspensa. Fale com o suporte.' });
    // Sessão de design do admin: a permissão do lojista precisa estar valendo agora (design.rules.ts).
    if (payload.ds || payload.adm) {
      const ds = payload.ds && payload.adm ? await this.design.sessionFor({ sub: payload.sub, tv: payload.tv ?? 0, ds: payload.ds, adm: payload.adm }) : null;
      if (!ds) throw new UnauthorizedException({ statusCode: 401, code: 'DESIGN_SESSION_ENDED', message: 'A permissão para editar o design desta loja acabou.' });
      (enterprise as unknown as { design: unknown }).design = ds;
      return enterprise;
    }
    // Funcionário: confere o login dele (ativo, senha não trocada) e traz permissões e turno.
    if (payload.st) {
      const staff = await this.staffService.forAuth(String(enterprise._id), payload.st, payload.stv ?? 0);
      if (!staff) throw new UnauthorizedException('Sessão encerrada. Entre novamente.');
      (enterprise as unknown as { staff: unknown }).staff = staff;
    }
    return enterprise;
  }
}
