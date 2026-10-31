import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Id da empresa autenticada (vem do JWT). Nunca confie em enterpriseId vindo do body. */
export const CurrentEnterprise = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  return String(req.user._id);
});
