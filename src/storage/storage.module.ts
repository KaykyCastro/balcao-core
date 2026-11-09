import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LocalStorageController, UploadController } from './storage.controller';
import { StorageScheduler } from './storage.scheduler';
import { StorageService } from './storage.service';
import { Upload, UploadSchema } from './upload.schema';

/** Armazenamento de arquivos (Cloudflare R2). Global: produtos, loja, empresa e admin usam. */
@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Upload.name, schema: UploadSchema }])],
  controllers: [UploadController, LocalStorageController],
  providers: [StorageService, StorageScheduler],
  exports: [StorageService],
})
export class StorageModule {}
