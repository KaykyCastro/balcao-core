import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import { Connection } from 'mongoose';
import { Public } from '../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Para o balanceador/monitor: 200 se o Mongo responde, 503 se não. Não expõe detalhes. */
  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    try {
      await this.connection.db!.admin().ping();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'down' });
    }
  }
}
