import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_WHEN_BLOCKED_KEY } from '../decorators/allow-when-blocked.decorator';

/**
 * Roda depois do JwtAuthGuard. Se a empresa está bloqueada por fatura vencida,
 * só deixa passar rotas públicas e as marcadas com @AllowWhenBlocked() (billing).
 */
@Injectable()
export class BillingGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_BLOCKED_KEY, targets)) return true;

    const user = ctx.switchToHttp().getRequest().user;
    if (user?.role !== 'admin' && user?.billing?.status === 'blocked') {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          code: 'BILLING_BLOCKED',
          message: 'Conta bloqueada por fatura em aberto. Regularize o pagamento em /billing para continuar.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
