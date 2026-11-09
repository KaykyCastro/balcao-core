import { encryptedFields } from '../../common/security/field-crypto';
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

  /** Descontos sobre os produtos: cupom e crédito de cashback usados. totalCents já vem com eles descontados. */
  @Prop(raw({ couponId: { type: MongooseSchema.Types.ObjectId, default: null }, couponCode: { type: String, default: '' }, couponCents: { type: Number, default: 0 }, creditCents: { type: Number, default: 0 } }))
  discount?: { couponId: Types.ObjectId | null; couponCode: string; couponCents: number; creditCents: number };

  /** Cashback que o comprador ganha quando o pedido for pago (crédito nesta loja). */
  @Prop({ default: 0, min: 0 })
  cashbackCents: number;

  /** phone e document criptografados (field-crypto); phoneIdx = índice cego para buscar o pedido pelo telefone. */
  @Prop(raw({ name: String, email: String, phone: String, document: String, phoneIdx: String }))
  customer: { name: string; email: string; phone: string; document?: string };

  @Prop(raw({ cep: String, street: String, number: String, complement: String, district: String, city: String, state: String }))
  address: { cep: string; street: string; number: string; complement?: string; district: string; city: string; state: string } | null;

  @Prop({ default: '', maxlength: 500 })
  notes: string;

  @Prop(raw({
    checkoutUrl: { type: String, default: null }, preferenceId: { type: String, default: null }, paymentId: { type: String, default: null },
    method: { type: String, default: null }, paidAmountCents: { type: Number, default: null }, paidAt: { type: Date, default: null }, refundedAt: { type: Date, default: null },
    mode: { type: String, default: 'online' }, onDelivery: { method: String, changeForCents: Number },
  }))
  payment: {
    /** online = Mercado Pago no checkout; on_delivery = paga na entrega/retirada (dinheiro, maquininha, Pix). */
    mode?: 'online' | 'on_delivery'; onDelivery?: { method: string; changeForCents?: number | null } | null;
    checkoutUrl: string | null; preferenceId: string | null; paymentId: string | null; method: string | null; paidAmountCents: number | null; paidAt: Date | null; refundedAt: Date | null };

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

  /** Cancelado depois de pago: o estorno automático pelo Mercado Pago falhou; o lojista devolve na mão. */
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
  /** Prova do aceite das condições da compra: quando, qual versão e de onde (IP). */
  @Prop(raw({ acceptedAt: Date, termsVersion: String, ip: String, _id: false }))
  consent?: { acceptedAt: Date; termsVersion: string; ip: string } | null;

  /** Conta online do comprador (quando comprou logado ou confirmou o e-mail depois). */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Shopper', default: null, index: true })
  shopperId: Types.ObjectId | null;

  /** Cadastro em "Clientes" da loja ligado a este pedido. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'CustomerSchema', default: null })
  customerId: Types.ObjectId | null;

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

  /**
   * Compra protegida: prazo para a loja enviar, confirmação de recebimento pelo comprador e reclamação.
   * active = esperando entrega; confirmed = comprador recebeu (ou prazo passou sem queixa); disputed = reclamação aberta; refunded = devolvido.
   */
  @Prop(raw({
    status: { type: String, enum: ['active', 'confirmed', 'disputed', 'refunded'], default: 'active' },
    mode: { type: String, default: 'ecommerce' }, shipBy: { type: Date, default: null }, graceAt: { type: Date, default: null }, warnedAt: { type: Date, default: null }, autoConfirmAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null }, confirmedBy: { type: String, default: '' },
  }))
  protection?: { status: 'active' | 'confirmed' | 'disputed' | 'refunded'; mode?: 'ecommerce' | 'whatsapp' | 'catalog' | 'menu'; shipBy: Date | null; graceAt?: Date | null; warnedAt: Date | null; autoConfirmAt: Date | null; confirmedAt: Date | null; confirmedBy: string } | null;

  @Prop(raw({
    status: { type: String, enum: ['open', 'resolved_refund', 'resolved_seller'] }, reason: String, message: String, openedAt: Date,
    sellerReply: String, sellerRepliedAt: Date, escalatedAt: Date, resolvedAt: Date, resolvedBy: String, note: String,
  }))
  dispute?: { status: 'open' | 'resolved_refund' | 'resolved_seller'; reason: string; message: string; openedAt: Date; sellerReply?: string; sellerRepliedAt?: Date; escalatedAt?: Date; resolvedAt?: Date; resolvedBy?: string; note?: string } | null;

  /** Etiqueta comprada pelo Balcão no Melhor Envio (debita a carteira do lojista). */
  @Prop(raw({
    provider: String, id: String, protocol: String, serviceId: Number, serviceName: String, priceCents: Number,
    status: { type: String, enum: ['cart', 'generated', 'posted', 'delivered', 'canceled'] }, trackingCode: String, error: String,
    createdAt: Date, printedAt: Date, postedAt: Date,
  }))
  label?: { provider: 'melhorenvio'; id: string; protocol?: string; serviceId?: number; serviceName?: string; priceCents?: number; status: 'cart' | 'generated' | 'posted' | 'delivered' | 'canceled'; trackingCode?: string; error?: string; createdAt: Date; printedAt?: Date | null; postedAt?: Date | null } | null;

  /** Link de acompanhamento cifrado, para os e-mails mandarem o link do pedido (o token em si nunca é guardado aberto). */
  @Prop({ type: String, default: null, select: false })
  linkSealed: string | null;

  /** Compra sem conta: o e-mail foi confirmado por código antes de pagar. */
  @Prop({ default: false })
  emailVerified: boolean;

  /** Modo da loja quando o pedido foi feito (define os prazos da Compra protegida). */
  @Prop({ type: String, enum: ['ecommerce', 'whatsapp', 'catalog', 'menu'], default: 'ecommerce' })
  mode: 'ecommerce' | 'whatsapp' | 'catalog' | 'menu';

  /** Pedido na mesa: número da mesa (bares e restaurantes). */
  @Prop({ type: Number, default: null })
  table: number | null;

  /** Lojista já abriu o pedido (contador de "novos"). */
  @Prop({ default: false })
  seen: boolean;
}

export const OrderSchemaFactory = SchemaFactory.createForClass(Order);
// Dados pessoais do comprador criptografados (telefone, CPF, endereço; cidade e UF abertas para frete e vitrine).
OrderSchemaFactory.plugin(encryptedFields(['customer.phone', 'customer.document', 'address.cep', 'address.street', 'address.number', 'address.complement', 'address.district'], { phoneIndex: { from: 'customer.phone', to: 'customer.phoneIdx' } }));
OrderSchemaFactory.index({ enterpriseId: 1, createdAt: -1 });
OrderSchemaFactory.index({ enterpriseId: 1, status: 1, createdAt: -1 });
OrderSchemaFactory.index({ storeId: 1, number: 1 }, { unique: true });
OrderSchemaFactory.index({ status: 1, expiresAt: 1 });
OrderSchemaFactory.index({ 'payment.paymentId': 1 }, { sparse: true });
