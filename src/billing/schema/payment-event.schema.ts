import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Log de notificações da InfinitePay (auditoria; o processamento em si é idempotente). */
@Schema({ timestamps: true })
export class PaymentEvent {
  @Prop({ required: true })
  orderNsu: string;

  @Prop({ type: String, default: '' })
  transactionNsu: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Invoice', default: null })
  invoiceId: Types.ObjectId | null;

  /** applied | already_paid | not_paid | amount_mismatch | unverifiable | invoice_not_found */
  @Prop({ default: 'received' })
  outcome: string;

  @Prop({ type: Object })
  raw: Record<string, unknown>;
}

export const PaymentEventSchemaFactory = SchemaFactory.createForClass(PaymentEvent);
PaymentEventSchemaFactory.index({ orderNsu: 1, transactionNsu: 1 });
PaymentEventSchemaFactory.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });
