import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, HydratedDocument } from 'mongoose';

export type SaleDocument = HydratedDocument<Sale>;
export type PaymentMethod = 'cash' | 'pix' | 'card' | 'other' | 'fiado' | 'online';

@Schema({ _id: false })
export class SaleItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ProductSchema', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  productName: string;

  @Prop({ required: true })
  productCode: string;

  @Prop({ required: true, min: 0 })
  unitPriceCents: number;

  /** Preço de tabela (sem desconto) no momento da venda. Ausente em vendas antigas. */
  @Prop({ min: 0 })
  originalUnitPriceCents?: number;

  /** false = produto de estoque ilimitado: o cancelamento não repõe nada. Ausente (vendas antigas) = true. */
  @Prop({ default: true })
  stockTracked?: boolean;

  @Prop({ required: true, min: 1 })
  quantity: number;

  /** Linha vendida pelo preço de uma promoção: no cancelamento as unidades voltam para ela. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Promotion', default: undefined })
  promotionId?: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  totalCents: number;
}
const SaleItemSchema = SchemaFactory.createForClass(SaleItem);

@Schema({ timestamps: true })
export class Sale {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  /** Opcional; obrigatório quando paymentMethod = 'fiado'. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'CustomerSchema', default: null, index: true })
  customerId: Types.ObjectId | null;

  @Prop({ type: String, enum: ['cash', 'pix', 'card', 'other', 'fiado', 'online'], required: true })
  paymentMethod: PaymentMethod;

  /** 'online' = pedido pago na loja online (InfinitePay do lojista). Ausente = balcão. */
  @Prop({ type: String, enum: ['pos', 'online'], default: 'pos' })
  channel?: 'pos' | 'online';

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', default: undefined })
  orderId?: Types.ObjectId;

  @Prop({ type: String, enum: ['completed', 'cancelled'], default: 'completed', index: true })
  status: 'completed' | 'cancelled';

  @Prop({ type: [SaleItemSchema], default: [] })
  items: SaleItem[];

  @Prop({ required: true, min: 0 })
  totalCents: number;

  /** Dinheiro: valor entregue pelo cliente (centavos). null quando não informado ou outra forma de pagamento. */
  @Prop({ type: Number, default: null, min: 0 })
  cashReceivedCents: number | null;

  /** Dinheiro: troco devolvido (centavos), calculado pela API. */
  @Prop({ type: Number, default: null, min: 0 })
  changeCents: number | null;

  /** Taxa do ERP cobrada nesta venda (0,5%, limitada pelo teto). */
  @Prop({ required: true, min: 0, default: 0 })
  feeCents: number;

  /** true se a taxa foi estornada no cancelamento (só possível antes de ser faturada). */
  @Prop({ default: false })
  feeReversed: boolean;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  /** Header Idempotency-Key: repetir o POST (rede caiu) devolve esta venda em vez de criar outra. */
  @Prop({ type: String, maxlength: 64 })
  idempotencyKey?: string;
}

export const SaleSchemaFactory = SchemaFactory.createForClass(Sale);
SaleSchemaFactory.index({ enterpriseId: 1, createdAt: -1 });
SaleSchemaFactory.index({ enterpriseId: 1, customerId: 1, createdAt: -1 });
SaleSchemaFactory.index({ enterpriseId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
