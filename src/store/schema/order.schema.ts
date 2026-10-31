import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { ORDER_STATUSES, type OrderStatus, type ShippingKind } from '../store.rules';
import type { SaleItem } from '../../sale/schema/sale.schema';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Store', required: true })
  storeId: Types.ObjectId;

  @Prop({ required: true })
  storeSlug: string;

  @Prop({ required: true })
  number: number;

  @Prop({ type: String, enum: ORDER_STATUSES, default: 'pending_payment', index: true })
  status: OrderStatus;

  /** Mesmo formato dos itens de venda (preço decidido na reserva, com promoção). */
  @Prop({ type: [Object], default: [] })
  items: SaleItem[];

  @Prop({ required: true, min: 0 })
  subtotalCents: number;

  @Prop(raw({ optionId: String, kind: String, name: String, carrier: String, priceCents: Number, etaText: String }))
  shipping: { optionId: string; kind: ShippingKind; name: string; carrier?: string; priceCents: number; etaText: string };

  @Prop({ required: true, min: 0 })
  totalCents: number;

  @Prop(raw({ name: String, email: String, phone: String, document: String }))
  customer: { name: string; email: string; phone: string; document?: string };

  @Prop(raw({ cep: String, street: String, number: String, complement: String, district: String, city: String, state: String }))
  address: { cep: string; street: string; number: string; complement?: string; district: string; city: string; state: string } | null;

  @Prop({ default: '', maxlength: 500 })
  notes: string;

  @Prop(raw({
    checkoutUrl: { type: String, default: null }, preferenceId: { type: String, default: null }, paymentId: { type: String, default: null },
    method: { type: String, default: null }, paidAmountCents: { type: Number, default: null }, paidAt: { type: Date, default: null }, refundedAt: { type: Date, default: null },
  }))
  payment: { checkoutUrl: string | null; preferenceId: string | null; paymentId: string | null; method: string | null; paidAmountCents: number | null; paidAt: Date | null; refundedAt: Date | null };

  /** Loja online recebe pelo Mercado Pago (split com a comissão do Balcão). */
  @Prop({ type: String, enum: ['mercadopago'], default: 'mercadopago' })
  provider: 'mercadopago';

  /** Conta Mercado Pago (user_id) que deve receber: confere o collector_id do pagamento. */
  @Prop({ required: true })
  payeeId: string;

  /** sha256 do token que o cliente usa para acompanhar o pedido. */
  @Prop({ required: true, select: false })
  accessHash: string;

  @Prop({ type: Date, required: true, index: true })
  expiresAt: Date;

  /** Estoque devolvido (pedido expirou ou foi cancelado). */
  @Prop({ default: false })
  stockReleased: boolean;

  /** Pagou depois de expirar e faltou estoque para algum item: o lojista precisa resolver. */
  @Prop({ default: false })
  stockIssue: boolean;

  /** Cancelado depois de pago: o lojista devolve o dinheiro pelo app da InfinitePay. */
  @Prop({ default: false })
  refundNeeded: boolean;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Sale', default: null })
  saleId: Types.ObjectId | null;

  @Prop(raw({ code: { type: String, default: '' }, url: { type: String, default: '' } }))
  tracking: { code: string; url: string };

  @Prop({ type: [{ status: String, at: Date, note: String, _id: false }], default: [] })
  history: { status: OrderStatus; at: Date; note?: string }[];

  @Prop({ default: '' })
  cancelReason: string;

  /** De onde veio o cliente: link da própria loja ou página "Lojas no Balcão" (muda a taxa). */
  @Prop({ type: String, enum: ['store', 'directory'], default: 'store' })
  source: 'store' | 'directory';

  /** Percentual da taxa do Balcão gravado no pedido (bps). */
  @Prop({ default: 0, min: 0 })
  feeRateBps: number;

  /** Taxa do Balcão (marketplace_fee): separada pelo Mercado Pago no pagamento (0 no teste grátis). */
  @Prop({ default: 0, min: 0 })
  feeCents: number;

  /** true = taxa já lançada (pagamento confirmado). */
  @Prop({ default: false })
  feeCharged: boolean;

  /** Lojista já abriu o pedido (contador de "novos"). */
  @Prop({ default: false })
  seen: boolean;
}

export const OrderSchemaFactory = SchemaFactory.createForClass(Order);
OrderSchemaFactory.index({ enterpriseId: 1, createdAt: -1 });
OrderSchemaFactory.index({ enterpriseId: 1, status: 1, createdAt: -1 });
OrderSchemaFactory.index({ storeId: 1, number: 1 }, { unique: true });
OrderSchemaFactory.index({ status: 1, expiresAt: 1 });
OrderSchemaFactory.index({ 'payment.paymentId': 1 }, { sparse: true });
