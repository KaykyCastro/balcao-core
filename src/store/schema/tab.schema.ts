import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type TabDocument = HydratedDocument<Tab>;

/** Como o cliente quer pagar: pelo celular, ou com o garçom (dinheiro, maquininha, Pix). */
export const TAB_PAYS = ['online', 'cash', 'card', 'pix'] as const;
export type TabPay = (typeof TAB_PAYS)[number];

export const TAB_ITEM_STATUSES = ['new', 'served', 'cancelled'] as const;
export type TabItemStatus = (typeof TAB_ITEM_STATUSES)[number];

/** Item lançado na comanda. Estoque e promoção são reservados no lançamento (como uma venda). */
export interface TabItem {
  _id: Types.ObjectId;
  productId: Types.ObjectId; productName: string; productCode: string;
  unitPriceCents: number; originalUnitPriceCents?: number; quantity: number; totalCents: number;
  promotionId?: Types.ObjectId; stockTracked: boolean;
  note: string;
  /** Adicionais escolhidos (cardápio), em texto; o preço já está em unitPriceCents. */
  options?: { group: string; name: string; qty: number; priceCents: number }[];
  /** Quem lançou: o cliente pelo celular ou a equipe pelo painel. */
  by: 'customer' | 'staff';
  at: Date;
  /** new = cozinha/bar ainda não entregou; served = entregue na mesa; cancelled = tirado da conta (estoque devolvido). */
  status: TabItemStatus;
  cancelReason?: string;
  /** Impresso na cozinha pela impressão automática. */
  printedAt?: Date;
}

/**
 * Comanda (conta) de uma mesa. Cada mesa pode ter várias contas abertas (cada pessoa ou grupo paga a sua).
 * O cliente pede sem pagar; o pagamento só fica disponível depois que o garçom (ou alguém no sistema) libera.
 */
@Schema({ timestamps: true })
export class Tab {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Store', required: true })
  storeId: Types.ObjectId;

  @Prop({ required: true })
  storeSlug: string;

  @Prop({ required: true })
  number: number;

  @Prop({ required: true, min: 1 })
  table: number;

  /** Nome da conta ("Ana", "Casal da janela"). */
  @Prop({ required: true, maxlength: 40 })
  name: string;

  /** open = consumindo; closed = paga (virou venda); cancelled = cancelada pela equipe. */
  @Prop({ type: String, enum: ['open', 'closed', 'cancelled'], default: 'open', index: true })
  status: 'open' | 'closed' | 'cancelled';

  @Prop({ type: [Object], default: [] })
  items: TabItem[];

  /** Taxa de serviço (centésimos de %) gravada na abertura; a equipe pode tirar. */
  @Prop({ default: 0, min: 0 })
  serviceRateBps: number;

  @Prop({ default: 0, min: 0 })
  subtotalCents: number;

  @Prop({ default: 0, min: 0 })
  serviceCents: number;

  @Prop({ default: 0, min: 0 })
  totalCents: number;

  /** Chamado pendente: garçom ou "quero pagar" (com a forma que o cliente prefere e o troco). */
  @Prop(raw({ kind: { type: String, enum: ['waiter', 'bill'] }, at: Date, pay: String, changeForCents: Number, _id: false }))
  call: { kind: 'waiter' | 'bill'; at: Date; pay?: TabPay | null; changeForCents?: number | null } | null;

  /** Garçom responsável pela conta (quem abriu, atendeu ou assumiu). Recebe os chamados dela. */
  @Prop(raw({ id: String, name: String, _id: false }))
  waiter: { id: string; name: string } | null;

  /**
   * Pagamento. released = liberado pela equipe (valor congelado em amountCents, sem novos itens).
   * Pelo celular: Checkout do Mercado Pago na conta do lojista. No local: dinheiro, maquininha, Pix.
   */
  @Prop(raw({
    released: { type: Boolean, default: false }, releasedAt: { type: Date, default: null }, releasedBy: { type: String, default: '' },
    amountCents: { type: Number, default: null }, attempt: { type: Number, default: 0 },
    checkoutUrl: { type: String, default: null }, preferenceId: { type: String, default: null },
    paymentId: { type: String, default: null }, method: { type: String, default: null }, provider: { type: String, default: null },
    paidAt: { type: Date, default: null }, paidBy: { type: String, default: '' },
  }))
  payment: {
    released: boolean; releasedAt: Date | null; releasedBy: string; amountCents: number | null; attempt: number;
    checkoutUrl: string | null; preferenceId: string | null; paymentId: string | null; method: string | null; provider: string | null;
    paidAt: Date | null; paidBy: string;
  };

  /** Pagou pelo celular depois que a equipe já tinha fechado a conta de outro jeito: devolver ao cliente. */
  @Prop({ default: false })
  refundNeeded: boolean;

  /** sha256 do token do link da conta (o celular de quem abriu e quem recebeu o convite). */
  @Prop({ required: true, select: false })
  accessHash: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Sale', default: null })
  saleId: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  closedAt: Date | null;

  @Prop({ default: '' })
  cancelReason: string;

  /** Quem abriu: cliente (QR Code) ou equipe. */
  @Prop({ type: String, enum: ['customer', 'staff'], default: 'customer' })
  openedBy: 'customer' | 'staff';
}

export const TabSchemaFactory = SchemaFactory.createForClass(Tab);
TabSchemaFactory.index({ enterpriseId: 1, status: 1, table: 1 });
TabSchemaFactory.index({ storeId: 1, number: 1 }, { unique: true });
TabSchemaFactory.index({ enterpriseId: 1, closedAt: -1 });
