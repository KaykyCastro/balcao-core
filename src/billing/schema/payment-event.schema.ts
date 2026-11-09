import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Log de notificações do Mercado Pago sobre faturas (auditoria; o processamento em si é idempotente). */
@Schema({ timestamps: true })
export class PaymentEvent {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Invoice', default: null })
  invoiceId: Types.ObjectId | null;

  @Prop({ type: String, default: '' })
  paymentId: string;

  /** applied | already_paid | not_paid | amount_mismatch | not_this_invoice | unverifiable | invoice_not_found | ignored */
  @Prop({ default: 'received' })
  outcome: string;

  @Prop({ type: Object })
  raw: Record<string, unknown>;
}

export const PaymentEventSchemaFactory = SchemaFactory.createForClass(PaymentEvent);
PaymentEventSchemaFactory.index({ invoiceId: 1, paymentId: 1 });
PaymentEventSchemaFactory.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });
