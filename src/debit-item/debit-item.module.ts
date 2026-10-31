import { Module } from '@nestjs/common';
import { DebitItemService } from './debit-item.service';
import { DebitItemController } from './debit-item.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { DebitItemSchema, DebitItemSchemaFactory } from './schema/debit-item.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DebitItemSchema.name, schema: DebitItemSchemaFactory }])
  ],
  controllers: [DebitItemController],
  providers: [DebitItemService],
  exports: [DebitItemService]
})
export class DebitItemModule {}
