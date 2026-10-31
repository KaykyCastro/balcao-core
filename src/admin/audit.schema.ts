import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Trilha de tudo que um administrador altera. Só inserção. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  actorId: Types.ObjectId;

  @Prop({ required: true })
  actorEmail: string;

  @Prop({ required: true, index: true })
  action: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  targetEnterpriseId: Types.ObjectId | null;

  @Prop({ type: Object, default: {} })
  meta: Record<string, unknown>;
}
export const AuditLogSchemaFactory = SchemaFactory.createForClass(AuditLog);
AuditLogSchemaFactory.index({ createdAt: -1 });
