import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StorageService } from './storage.service';

/** De hora em hora: apaga envios abandonados e arquivos enviados que ninguém usou. */
@Injectable()
export class StorageScheduler {
  private readonly log = new Logger('StorageScheduler');
  constructor(private readonly storage: StorageService) {}
  @Cron(CronExpression.EVERY_HOUR)
  async run() {
    const n = await this.storage.cleanup().catch((e) => { this.log.error((e as Error).message); return 0; });
    if (n) this.log.log(`${n} arquivo(s) esquecido(s) apagado(s)`);
  }
}
