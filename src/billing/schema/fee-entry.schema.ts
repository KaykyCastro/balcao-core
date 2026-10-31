import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Razão da taxa: uma linha por venda com taxa > 0. Auditável e idempotente (saleId único). */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class FeeEntry {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Sale', required: true, unique: true })
  saleId: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  baseCents: number;

  @Prop({ required: true })
  rateBps: number;

  /** Taxa efetivamente cobrada (pode ser menor que a calculada na venda que cruza o teto). */
  @Prop({ required: true, min: 1 })
  feeCents: number;

  /** 'online' = venda da loja online: taxa própria e FORA do teto mensal do balcão. Ausente = balcão. */
  @Prop({ type: String, enum: ['pos', 'online'], default: 'pos' })
  channel?: 'pos' | 'online';

  /** true = já recebida na hora (comissão do Mercado Pago na loja online): não vira dívida nem fatura. */
  @Prop({ default: false })
  collected?: boolean;

  /** 'YYYY-MM' (America/Fortaleza) em que a venda ocorreu. */
  @Prop({ required: true })
  period: string;

  /** Fatura que cobrou esta taxa (null = ainda não faturada). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Invoice', default: null })
  invoiceId: Types.ObjectId | null;

  /** Preenchido quando a venda é cancelada antes de a taxa ser faturada. */
  @Prop({ type: Date, default: null })
  reversedAt: Date | null;
}

export const FeeEntrySchemaFactory = SchemaFactory.createForClass(FeeEntry);
FeeEntrySchemaFactory.index({ enterpriseId: 1, invoiceId: 1, reversedAt: 1, period: 1 });
FeeEntrySchemaFactory.index({ invoiceId: 1 });
