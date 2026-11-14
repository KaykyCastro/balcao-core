import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/** Como o lojista recebe no balcão: Pix (chave própria ou Mercado Pago), maquininha Point, maquininha Stone. */
@Schema({ timestamps: true, collection: 'pos_configs' })
export class PosConfig {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, unique: true })
  enterpriseId: Types.ObjectId;

  @Prop(raw({
    mode: { type: String, enum: ['off', 'key', 'mercadopago'], default: 'off' },
    keyType: { type: String, enum: ['cpf', 'cnpj', 'email', 'phone', 'random'], default: 'cnpj' },
    key: { type: String, default: '' }, holder: { type: String, default: '' }, city: { type: String, default: '' },
  }))
  pix: { mode: 'off' | 'key' | 'mercadopago'; keyType: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random'; key: string; holder: string; city: string };

  @Prop(raw({ enabled: { type: Boolean, default: false }, terminalId: { type: String, default: '' }, label: { type: String, default: '' } }))
  point: { enabled: boolean; terminalId: string; label: string };

  @Prop(raw({
    enabled: { type: Boolean, default: false }, serial: { type: String, default: '' },
    skSealed: { type: String, default: null, select: false }, skHint: { type: String, default: '' },
  }))
  stone: { enabled: boolean; serial: string; skSealed?: string | null; skHint: string };

  /** InfiniteTap: o celular vira maquininha pelo app da InfinitePay. `handle` = InfiniteTag da conta que recebe. */
  @Prop(raw({ enabled: { type: Boolean, default: false }, handle: { type: String, default: '' }, doc: { type: String, default: '' } }))
  tap: { enabled: boolean; handle: string; doc: string };
}
export const PosConfigSchemaFactory = SchemaFactory.createForClass(PosConfig);

export type PosProvider = 'mp_point' | 'mp_pix' | 'stone' | 'pix_key' | 'infinitetap';
export type PosStatus = 'pending' | 'paid' | 'failed' | 'canceled';
export type PosPaymentDocument = HydratedDocument<PosPayment>;

/** Uma cobrança no balcão. Vira venda (com comprovante) só quando o pagamento é confirmado. */
@Schema({ timestamps: true, collection: 'pos_payments' })
export class PosPayment {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: String, required: true }) provider: PosProvider;
  @Prop({ type: String, enum: ['credit', 'debit', 'pix'], required: true }) method: 'credit' | 'debit' | 'pix';
  @Prop({ default: 1 }) installments: number;
  @Prop({ type: String, enum: ['pending', 'paid', 'failed', 'canceled'], default: 'pending', index: true }) status: PosStatus;
  @Prop({ required: true, min: 1 }) amountCents: number;
  @Prop({ type: [{ productId: String, quantity: Number, options: { type: [{ g: String, i: String, q: Number, _id: false }], default: undefined }, note: String, _id: false }], default: [] }) items: { productId: string; quantity: number; options?: { g: string; i: string; q: number }[]; note?: string }[];
  /** Desconto do carrinho, repassado para a venda quando o pagamento confirma. */
  @Prop(raw({ mode: String, value: Number, reason: String, _id: false })) discount?: { mode: 'percent' | 'amount'; value: number; reason?: string } | null;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) customerId: Types.ObjectId | null;
  /** Fechamento de comanda de mesa: o valor vem da conta e, pago, a conta fecha (em vez de uma venda avulsa). */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) tabId: Types.ObjectId | null;
  /** Funcionário que cobrou (a venda sai no nome dele). */
  @Prop(raw({ id: String, name: String, _id: false })) staff?: { id: string; name: string } | null;
  /** Id da cobrança no provedor (order do Mercado Pago ou da Stone). */
  @Prop({ default: '' }) providerRef: string;
  @Prop({ type: String, default: null }) qrCode: string | null;
  @Prop({ type: String, default: null }) qrBase64: string | null;
  /** InfiniteTap: deep link que abre o app da InfinitePay com esta cobrança. */
  @Prop({ type: String, default: null }) deeplink: string | null;
  @Prop({ type: Date, required: true }) expiresAt: Date;
  @Prop(raw({ paymentId: String, brand: String, installments: Number, authCode: String, methodType: String })) detail?: { paymentId?: string | null; brand?: string | null; installments?: number | null; authCode?: string | null; methodType?: string | null } | null;
  @Prop({ type: Date, default: null }) paidAt: Date | null;
  /** Quem confirmou (Pix na chave: o caixa confere no banco). */
  @Prop({ type: String, default: '' }) confirmedBy: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) saleId: Types.ObjectId | null;
  @Prop({ default: '' }) failReason: string;
  /** Mesmo botão apertado duas vezes não cria duas cobranças. */
  @Prop({ type: String }) clientKey?: string;
}
export const PosPaymentSchemaFactory = SchemaFactory.createForClass(PosPayment);
PosPaymentSchemaFactory.index({ enterpriseId: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
PosPaymentSchemaFactory.index({ status: 1, createdAt: -1 });
// Cada transação do InfiniteTap (NSU) paga uma cobrança só: o mesmo retorno não fecha duas vendas.
PosPaymentSchemaFactory.index({ 'detail.paymentId': 1 }, { unique: true, partialFilterExpression: { provider: 'infinitetap', 'detail.paymentId': { $type: 'string' } } });
