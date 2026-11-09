import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { designDenied } from './design.rules';
import { DesignService, type DesignSession } from './design.service';

/**
 * Sessão de design do admin (token com `ds`): só as rotas de design passam (design.rules.ts).
 * Sessões normais (dono, colaborador, admin) não são afetadas.
 */
@Injectable()
export class DesignSessionGuard implements CanActivate {
  constructor(private readonly design: DesignService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: { design?: DesignSession }; method: string; path?: string; url: string; body?: unknown }>();
    const ds = req.user?.design;
    if (!ds) return true;
    const path = (req.path ?? req.url).split('?')[0];
    const why = designDenied(req.method, path, req.body);
    if (why) throw new ForbiddenException({ statusCode: 403, code: 'DESIGN_SCOPE', message: why });
    if (req.method.toUpperCase() === 'PUT' && /^\/store-config\/page\/?$/.test(path)) this.design.countSave(ds.grantId);
    return true;
  }
}
