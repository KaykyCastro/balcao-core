import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Cupom de desconto da loja online. `used` conta pedidos que reservaram o cupom (volta se o pedido não for pago). */
@Schema({ collection: 'coupons', timestamps: true })
export class Coupon {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) enterpriseId: Types.ObjectId;
  @Prop({ required: true }) code: string;
  @Prop({ default: '' }) title: string;
  @Prop({ type: String, enum: ['percent', 'amount'], required: true }) kind: 'percent' | 'amount';
  @Prop({ type: Number, default: null }) percent: number | null;
  @Prop({ type: Number, default: null }) amountCents: number | null;
  @Prop({ default: 0 }) minOrderCents: number;
  @Prop({ type: Number, default: null }) maxDiscountCents: number | null;
  @Prop({ type: Date, default: null }) startsAt: Date | null;
  @Prop({ type: Date, default: null }) endsAt: Date | null;
  @Prop({ type: Number, default: null }) maxUses: number | null;
  @Prop({ default: 0 }) used: number;
  @Prop({ default: false }) onePerCustomer: boolean;
  /** Aparece na vitrine da loja e em Lojas no Balcão (senão, só quem tem o código). */
  @Prop({ default: true }) public: boolean;
  @Prop({ default: true }) active: boolean;
}
export const CouponSchema = SchemaFactory.createForClass(Coupon);
CouponSchema.index({ enterpriseId: 1, code: 1 }, { unique: true });
CouponSchema.index({ public: 1, active: 1, endsAt: 1 });
