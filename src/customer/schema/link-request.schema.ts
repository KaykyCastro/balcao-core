import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Pedido para pertencer à loja (o comprador pede, `join`) ou convite da loja (o lojista convida a partir
 * de um cadastro, `invite`). Só vira vínculo quando o outro lado aceita.
 */
@Schema({ collection: 'customer_link_requests', timestamps: true })
export class CustomerLinkRequest {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  shopperId: Types.ObjectId;

  @Prop({ type: String, enum: ['join', 'invite'], required: true })
  direction: 'join' | 'invite';

  @Prop({ type: String, enum: ['pending', 'accepted', 'declined', 'cancelled'], default: 'pending', index: true })
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';

  /** Convite: o cadastro que a loja quer ligar. Aceito: o cadastro que ficou ligado. */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  customerId: Types.ObjectId | null;

  /** Recado do comprador ao pedir (até 200 caracteres). */
  @Prop({ default: '', maxlength: 200 })
  message: string;

  /** Dados que o comprador mostrou à loja ao pedir (para o lojista reconhecer e unir com um cadastro). */
  @Prop({ type: Object, default: null })
  person: { name: string; email: string; phone: string } | null;

  @Prop({ type: Date, default: null })
  decidedAt: Date | null;
}

export type CustomerLinkRequestDocument = HydratedDocument<CustomerLinkRequest>;
export const CustomerLinkRequestSchemaFactory = SchemaFactory.createForClass(CustomerLinkRequest);
// No máximo um pedido/convite em aberto por pessoa e loja.
CustomerLinkRequestSchemaFactory.index({ enterpriseId: 1, shopperId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
