import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Cashback como crédito na loja. `earn` = crédito ganho num pedido pago (com validade e saldo restante);
 * `spend` = crédito usado num pedido (com de quais lotes saiu, para devolver se o pedido não for pago).
 */
@Schema({ collection: 'store_credits', timestamps: true })
export class StoreCredit {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) shopperId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) enterpriseId: Types.ObjectId;
  @Prop({ type: String, enum: ['earn', 'spend'], required: true }) kind: 'earn' | 'spend';
  @Prop({ required: true, min: 0 }) amountCents: number;
  @Prop({ default: 0, min: 0 }) remainingCents: number;
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) orderId: Types.ObjectId;
  @Prop({ type: [{ id: MongooseSchema.Types.ObjectId, cents: Number }], default: [] }) allocations: { id: Types.ObjectId; cents: number }[];
  /** active = valendo; reversed = desfeito (pedido reembolsado, ou crédito usado devolvido). */
  @Prop({ type: String, enum: ['active', 'reversed'], default: 'active' }) status: 'active' | 'reversed';
}
export const StoreCreditSchema = SchemaFactory.createForClass(StoreCredit);
StoreCreditSchema.index({ shopperId: 1, enterpriseId: 1, kind: 1, status: 1, expiresAt: 1 });
StoreCreditSchema.index({ orderId: 1, kind: 1 });
