import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * QR de convite de um cadastro: o lojista mostra no balcão, o cliente lê, entra na conta e fica ligado
 * àquele cadastro (a loja escolheu a pessoa, a pessoa aceitou). Uso único; guarda só o hash do código.
 */
@Schema({ collection: 'customer_invite_codes', timestamps: { createdAt: true, updatedAt: false } })
export class CustomerInviteCode {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  customerId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash: string;

  /** Some sozinho 7 dias depois de vencer (TTL). */
  @Prop({ type: Date, required: true, index: { expireAfterSeconds: 7 * 86_400 } })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  usedAt: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  usedBy: Types.ObjectId | null;
}

export type CustomerInviteCodeDocument = HydratedDocument<CustomerInviteCode>;
export const CustomerInviteCodeSchemaFactory = SchemaFactory.createForClass(CustomerInviteCode);
