import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { OFF_HOURS_ALLOWED, staffAccess } from './staff.rules';
import type { StaffSession } from './staff.service';

/**
 * Funcionário logado: só passa nas rotas que a permissão dele libera (staff.rules.ts), e só com o turno aberto.
 * Fora do horário de acesso, quase tudo é recusado. Dono e rotas públicas não são afetados.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: { staff?: StaffSession }; method: string; path?: string; url: string }>();
    const st = req.user?.staff;
    if (!st) return true;
    const path = req.path ?? req.url;
    // Fora do horário definido pelo dono: só ver o aviso, sair e encerrar o turno.
    if (st.offHours && !OFF_HOURS_ALLOWED.test(path.split('?')[0].replace(/\/+$/, ''))) {
      throw new ForbiddenException({ statusCode: 403, code: 'STAFF_OFF_HOURS', message: `Fora do seu horário de acesso.${st.nextAccess ? ` Seu próximo horário: ${st.nextAccess}.` : ' Fale com o responsável pela loja.'}`, nextAccess: st.nextAccess ?? null });
    }
    const a = staffAccess(req.method, path, st.permissions);
    if (!a.ok) throw new ForbiddenException({ statusCode: 403, code: 'STAFF_FORBIDDEN', message: 'Seu acesso não permite isso. Peça ao responsável pela loja.' });
    if (a.needsShift && !st.shiftId) throw new ForbiddenException({ statusCode: 403, code: 'SHIFT_REQUIRED', message: 'Inicie o serviço para continuar.' });
    return true;
  }
}
