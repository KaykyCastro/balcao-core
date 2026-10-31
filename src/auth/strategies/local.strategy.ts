import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({ usernameField: 'email' });
  }

  async validate(email: unknown, password: unknown) {
    // O guard roda antes do ValidationPipe: rejeita aqui objetos ({"$ne": ""}) e textos gigantes.
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 72 || !password) {
      throw new UnauthorizedException('E-mail ou senha inválidos');
    }
    const enterprise = await this.authService.validate(email, password);
    if (!enterprise) throw new UnauthorizedException('E-mail ou senha inválidos');
    return enterprise;
  }
}
