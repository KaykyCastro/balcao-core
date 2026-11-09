import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { ShopperService } from './shopper.service';

/** Exige comprador logado (cookie balcao_shopper). Use junto com @Public(): é outra sessão, não a do lojista. */
@Injectable()
export class ShopperGuard implements CanActivate {
  constructor(private readonly shoppers: ShopperService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const s = await this.shoppers.fromRequest(req);
    if (!s) throw new UnauthorizedException({ code: 'SHOPPER_AUTH', message: 'Entre na sua conta' });
    req.shopper = s;
    return true;
  }
}

export const CurrentShopper = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().shopper);
