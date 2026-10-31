import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Message, MessageSchemaFactory } from './message.schema';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { EnterpriseSchema, EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';

@Module({
  imports: [MongooseModule.forFeature([
    { name: Message.name, schema: MessageSchemaFactory },
    { name: EnterpriseSchema.name, schema: EnterpriseSchemaFactory },
  ])],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
