import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

export type MessageLevel = 'info' | 'warning';

/** Aviso do admin para uma empresa. Um envio para "todas" gera um documento por empresa, ligados por `broadcastId`. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Message {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  enterpriseId: Types.ObjectId;

  /** Agrupa os documentos de um mesmo envio (e o id do próprio envio). */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  broadcastId: Types.ObjectId;

  @Prop({ required: true, maxlength: 120 })
  title: string;

  @Prop({ required: true, maxlength: 2000 })
  body: string;

  @Prop({ required: true, enum: ['info', 'warning'], default: 'info' })
  level: MessageLevel;

  @Prop({ required: true })
  senderEmail: string;

  @Prop({ type: Date, default: null })
  readAt: Date | null;
}
export const MessageSchemaFactory = SchemaFactory.createForClass(Message);
MessageSchemaFactory.index({ enterpriseId: 1, createdAt: -1 });
MessageSchemaFactory.index({ enterpriseId: 1, readAt: 1 });
