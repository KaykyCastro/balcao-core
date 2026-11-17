import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type ExchangeDocument = HydratedDocument<Exchange>;

/**
 * Troca ou devolução feita no balcão. Fica guardada para sempre (sem TTL): o lojista consulta o histórico de trocas e a
 * venda original continua inteira no histórico de vendas. Os produtos novos viram uma venda própria (`newSaleId`).
 */
@Schema({ collection: 'exchanges', timestamps: { createdAt: true, updatedAt: false } })
export class Exchange {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) enterpriseId: Types.ObjectId;

  /** Venda original (a do comprovante) e o código impresso nele. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) saleId: Types.ObjectId;
  @Prop({ required: true }) saleCode: string;
  @Prop({ type: Date, required: true }) saleAt: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) customerId: Types.ObjectId | null;

  /** Itens devolvidos: a linha da venda, a quantidade e o valor pago por eles (com promoção e desconto). */
  @Prop({ type: [{ _id: false, line: Number, productId: MongooseSchema.Types.ObjectId, productName: String, productCode: String, quantity: Number, totalCents: Number, stockTracked: Boolean }], default: [] })
  returned: { line: number; productId: Types.ObjectId; productName: string; productCode: string; quantity: number; totalCents: number; stockTracked: boolean }[];
  @Prop({ required: true, min: 0 }) returnedCents: number;

  /** Produtos novos (troca): a venda criada e o total dela. Sem produtos novos = devolução. */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) newSaleId: Types.ObjectId | null;
  @Prop({ default: 0, min: 0 }) newCents: number;

  /** Diferença paga pelo cliente (quando os novos custam mais) e a forma de pagamento dela. */
  @Prop({ default: 0, min: 0 }) toPayCents: number;
  @Prop({ type: String, default: null }) payMethod: string | null;

  /** Sobra: abate do fiado (venda original no fiado), crédito na loja ou dinheiro de volta. */
  @Prop({ default: 0, min: 0 }) debtAbatedCents: number;
  @Prop({ default: 0, min: 0 }) creditCents: number;
  @Prop({ default: 0, min: 0 }) refundCents: number;
  @Prop({ type: String, default: null }) refundMethod: 'cash' | 'pix' | 'card' | 'other' | null;

  @Prop({ default: '' }) reason: string;
  @Prop(raw({ id: { type: MongooseSchema.Types.ObjectId }, name: String, _id: false }))
  staff?: { id?: Types.ObjectId; name: string } | null;
  /** Header Idempotency-Key: a mesma troca enviada duas vezes (rede caiu) não é feita duas vezes. */
  @Prop({ type: String, maxlength: 64 }) idempotencyKey?: string;
  createdAt?: Date;
}
export const ExchangeSchema = SchemaFactory.createForClass(Exchange);
ExchangeSchema.index({ enterpriseId: 1, createdAt: -1 });
ExchangeSchema.index({ enterpriseId: 1, saleId: 1 });
ExchangeSchema.index({ enterpriseId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
