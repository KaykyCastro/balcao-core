import { Module } from '@nestjs/common';
import { EnterpriseService } from './enterprise.service';
import { EnterpriseController } from './enterprise.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { EnterpriseSchemaFactory } from './schema/enterprise.schema';
import { LegalModule } from '../legal/legal.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'EnterpriseSchema', schema: EnterpriseSchemaFactory }]),
    LegalModule,
  ],
  controllers: [EnterpriseController],
  providers: [EnterpriseService],
  exports: [EnterpriseService]
})
export class EnterprisesModule {}
