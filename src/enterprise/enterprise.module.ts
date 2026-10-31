import { Module } from '@nestjs/common';
import { EnterpriseService } from './enterprise.service';
import { EnterpriseController } from './enterprise.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { EnterpriseSchemaFactory } from './schema/enterprise.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'EnterpriseSchema', schema: EnterpriseSchemaFactory }])
  ],
  controllers: [EnterpriseController],
  providers: [EnterpriseService],
  exports: [EnterpriseService]
})
export class EnterprisesModule {}
