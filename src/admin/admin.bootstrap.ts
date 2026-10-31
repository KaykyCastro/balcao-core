import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnterpriseService } from '../enterprise/enterprise.service';

/** ADMIN_EMAIL + ADMIN_PASSWORD (8+ caracteres): cria o administrador na primeira subida. Nunca troca a senha de uma conta existente. */
@Injectable()
export class AdminBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrap.name);
  constructor(private readonly config: ConfigService, private readonly enterprises: EnterpriseService) {}

  async onApplicationBootstrap() {
    const email = this.config.get<string>('ADMIN_EMAIL');
    const password = this.config.get<string>('ADMIN_PASSWORD');
    if (!email) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return void this.logger.error('ADMIN_EMAIL inválido');
    try {
      const exists = await this.enterprises.findByEmailForLogin(email);
      if (!exists && (!password || password.length < 12)) return void this.logger.error('ADMIN_PASSWORD precisa ter 12+ caracteres para criar o administrador');
      await this.enterprises.ensureAdmin(email, password ?? '');
    } catch (e) {
      this.logger.error(`Não foi possível preparar o administrador: ${(e as Error).message}`);
    }
  }
}
