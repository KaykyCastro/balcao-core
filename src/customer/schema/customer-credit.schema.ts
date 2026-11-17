import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Extrato do crédito do cliente na loja (balcão). Cada entrada e saída fica guardada para sempre (sem TTL), com o
 * saldo depois do movimento: o lojista sempre consegue explicar de onde veio e para onde foi o crédito.
 * - `troca`: sobra de uma troca virou crédito (+)
 * - `uso`: crédito usado para pagar uma venda (−)
 * - `estorno`: venda paga com crédito foi cancelada, o crédito volta (+)
 */
@Schema({ collection: 'customer_credits', timestamps: { createdAt: true, updatedAt: false } })
export class CustomerCredit {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) enterpriseId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) customerId: Types.ObjectId;
  @Prop({ type: String, enum: ['troca', 'uso', 'estorno'], required: true }) kind: 'troca' | 'uso' | 'estorno';
  /** Positivo = entrou; negativo = saiu. Centavos. */
  @Prop({ type: Number, required: true }) amountCents: number;
  @Prop({ type: Number, required: true, min: 0 }) balanceAfterCents: number;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) exchangeId: Types.ObjectId | null;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) saleId: Types.ObjectId | null;
  @Prop(raw({ id: { type: MongooseSchema.Types.ObjectId }, name: String, _id: false }))
  by?: { id?: Types.ObjectId; name: string } | null;
  createdAt?: Date;
}
export const CustomerCreditSchema = SchemaFactory.createForClass(CustomerCredit);
CustomerCreditSchema.index({ enterpriseId: 1, customerId: 1, createdAt: -1 });
