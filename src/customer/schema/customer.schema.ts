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
}

export const CustomerSchemaFactory = SchemaFactory.createForClass(CustomerSchema);
// Compatibilidade com o front: continua expondo `debitValue` em reais no JSON.
CustomerSchemaFactory.virtual('debitValue').get(function (this: { debitCents?: number }) {
  return (this.debitCents ?? 0) / 100;
});
