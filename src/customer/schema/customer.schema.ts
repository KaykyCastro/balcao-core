import { encryptedFields } from '../../common/security/field-crypto';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, HydratedDocument } from 'mongoose';

export type CustomerDocument = HydratedDocument<CustomerSchema>;

@Schema({ timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } })
export class CustomerSchema {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: '' })
  address: string;

  @Prop({ default: '' })
  numberWithPrefix: string;

  /** Dívida de fiado em centavos (inteiro, sem erro de ponto flutuante). */
  @Prop({ required: true, default: 0, min: 0 })
  debitCents: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  /** Conta online do cliente (login nas lojas do Balcão). Criada no checkout logado ou vinculada pelo lojista. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Shopper', default: null })
  shopperId: Types.ObjectId | null;

  @Prop({ default: '', lowercase: true, trim: true, maxlength: 160 })
  email: string;

  /** Cadastro criado automaticamente por uma compra online. */
  @Prop({ type: String, enum: ['pos', 'online'], default: 'pos' })
  origin: 'pos' | 'online';

  /** Desde quando pertence à loja (pediu e a loja aceitou, ou aceitou o convite). Ver membership.rules.ts. */
  @Prop({ type: Date, default: null })
  memberSince: Date | null;
}

export const CustomerSchemaFactory = SchemaFactory.createForClass(CustomerSchema);
// Dados pessoais criptografados (telefone e endereço). Nome e e-mail ficam abertos: a busca de clientes usa o nome.
CustomerSchemaFactory.plugin(encryptedFields(['address', 'numberWithPrefix']));
// Um cliente por conta online em cada empresa.
CustomerSchemaFactory.index({ enterpriseId: 1, shopperId: 1 }, { unique: true, partialFilterExpression: { shopperId: { $type: 'objectId' } } });
CustomerSchemaFactory.index({ shopperId: 1 });
// Compatibilidade com o front: continua expondo `debitValue` em reais no JSON.
CustomerSchemaFactory.virtual('debitValue').get(function (this: { debitCents?: number }) {
  return (this.debitCents ?? 0) / 100;
});
