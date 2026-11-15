import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Fechamento de caixa de um dia: o que se esperava na gaveta, o que foi contado e a diferença. Um por loja e dia. */
@Schema({ collection: 'cash_closings', timestamps: true })
export class CashClosing {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  /** 'AAAA-MM-DD' (horário de Brasília). */
  @Prop({ required: true })
  day: string;

  @Prop({ required: true, min: 0, default: 0 }) openingCents: number;
  @Prop({ required: true, min: 0 }) countedCents: number;
  @Prop({ required: true, min: 0 }) expectedCents: number;
  /** contado − esperado: negativo = faltou dinheiro, positivo = sobrou. */
  @Prop({ required: true }) diffCents: number;
  @Prop({ type: String, default: '', maxlength: 300 }) note: string;

  /** Números do dia no momento do fechamento (vendas feitas depois aparecem no resumo, não aqui). */
  @Prop(raw({ count: Number, revenueCents: Number, drawerTotalCents: Number, onlineCents: Number, fiadoSoldCents: Number, fiadoReceivedCents: Number, _id: false }))
  totals: { count: number; revenueCents: number; drawerTotalCents: number; onlineCents: number; fiadoSoldCents: number; fiadoReceivedCents: number };

  @Prop(raw({ name: String, staffId: { type: MongooseSchema.Types.ObjectId }, _id: false }))
  closedBy: { name: string; staffId?: Types.ObjectId | null };

  /** Quantas vezes o fechamento foi refeito. */
  @Prop({ default: 0 }) revisions: number;
}
export const CashClosingSchemaFactory = SchemaFactory.createForClass(CashClosing);
CashClosingSchemaFactory.index({ enterpriseId: 1, day: 1 }, { unique: true });
