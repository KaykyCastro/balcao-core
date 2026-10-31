import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PlatformSettings, PlatformSettingsSchemaFactory } from './settings.schema';
import { SettingsService } from './settings.service';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: PlatformSettings.name, schema: PlatformSettingsSchemaFactory }])],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
