import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { LegalService } from './legal.service';

/**
 * Registro de acesso (Marco Civil, art. 15) em um só lugar: toda requisição autenticada (lojista, colaborador, admin
 * ou comprador) anota quem, IP e hora, no máximo uma vez por hora por pessoa e IP. Roda depois dos guards.
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  constructor(private readonly legal: LegalService) {}
  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { user?: { _id?: unknown; role?: string; staff?: { id?: string } }; shopper?: { _id?: unknown } }>();
    const ip = req.ip ?? ''; const userAgent = String(req.headers['user-agent'] ?? '');
    const u = req.user;
    if (u?._id) {
      const account = String(u._id);
      if (u.staff?.id) this.legal.logAccess({ kind: 'staff', subjectId: String(u.staff.id), accountId: account, ip, userAgent });
      else this.legal.logAccess({ kind: u.role === 'admin' ? 'admin' : 'enterprise', subjectId: account, ip, userAgent });
    } else if (req.shopper?._id) {
      this.legal.logAccess({ kind: 'shopper', subjectId: String(req.shopper._id), ip, userAgent });
    }
    return next.handle();
  }
}
