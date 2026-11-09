import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessagesModule } from '../messages/messages.module';
import { Store, StoreSchemaFactory } from '../store/schema/store.schema';
import { AccessLogInterceptor } from './access-log.interceptor';
import { AdminPrivacyController, PrivacyController, PublicPrivacyController } from './legal.controller';
import { AccessLog, AccessLogSchemaFactory, AccountClosure, AccountClosureSchemaFactory, ConsentLog, ConsentLogSchemaFactory, PrivacyRequest, PrivacyRequestSchemaFactory } from './legal.schema';
import { LegalService } from './legal.service';

/** LGPD e Marco Civil: pedidos do titular, portabilidade, registros de acesso, prova de aceite e encerramento de conta. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccessLog.name, schema: AccessLogSchemaFactory },
      { name: ConsentLog.name, schema: ConsentLogSchemaFactory },
      { name: AccountClosure.name, schema: AccountClosureSchemaFactory },
      { name: PrivacyRequest.name, schema: PrivacyRequestSchemaFactory },
      { name: Store.name, schema: StoreSchemaFactory },
    ]),
    MessagesModule,
  ],
  controllers: [PublicPrivacyController, PrivacyController, AdminPrivacyController],
  providers: [LegalService, AccessLogInterceptor],
  exports: [LegalService, AccessLogInterceptor],
})
export class LegalModule {}
