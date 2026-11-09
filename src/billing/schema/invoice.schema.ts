import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, HydratedDocument } from 'mongoose';

export type InvoiceDocument = HydratedDocument<Invoice>;
export type InvoiceStatus = 'pending' | 'paid' | 'cancelled';

@Schema({ timestamps: true })
export class Invoice {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  /** 'monthly' = fechamento automático; 'on_demand' = empresa pediu para pagar antes. */
  @Prop({ type: String, enum: ['monthly', 'on_demand'], required: true })
  kind: 'monthly' | 'on_demand';

  @Prop({ required: true })
  periodFrom: string;

  @Prop({ required: true })
  periodTo: string;

  @Prop({ required: true, min: 1 })
  amountCents: number;

  @Prop({ type: String, enum: ['pending', 'paid', 'cancelled'], default: 'pending', index: true })
  status: InvoiceStatus;

  /** Fatura pendente com dueDate vencido bloqueia a conta (prazo padrão: 15 dias). */
  @Prop({ type: Date, required: true })
  dueDate: Date;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  @Prop({ type: String, enum: ['mercadopago', 'manual', null], default: null })
  paidVia: 'mercadopago' | 'manual' | null;

  // ---- Mercado Pago (Checkout Pro na conta do Balcão). external_reference = _id da fatura.
  @Prop({ type: String, default: null })
  checkoutUrl: string | null;

  @Prop({ type: String, default: null })
  preferenceId: string | null;

  /** Reserva atômica: impede dois links simultâneos para a mesma fatura. */
  @Prop({ type: Date, default: null })
  checkoutLockedAt: Date | null;

  @Prop({ type: String, default: null, index: true, sparse: true })
  paymentId: string | null;

  /** pix (bank_transfer), credit_card, debit_card, account_money... */
  @Prop({ type: String, default: null })
  paymentMethod: string | null;

  @Prop({ type: Number, default: null })
  paidAmountCents: number | null;

  /** Motivo/observação do admin (pagamento manual, extensão de prazo, cancelamento). */
  @Prop({ type: String, default: null, maxlength: 300 })
  note: string | null;

  /** Avisos já enviados desta fatura (reminder.rules.ts): um por tipo, com os canais que saíram. */
  @Prop({ type: [{ _id: false, kind: String, at: Date, channels: [String] }], default: [] })
  reminders: { kind: string; at: Date; channels: string[] }[];
}

export const InvoiceSchemaFactory = SchemaFactory.createForClass(Invoice);
InvoiceSchemaFactory.index({ enterpriseId: 1, status: 1, dueDate: 1 });
InvoiceSchemaFactory.index({ status: 1, dueDate: 1 });
