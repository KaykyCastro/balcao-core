import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Recebimento de fiado (o cliente pagou parte/todo o débito para a empresa). */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class CustomerPayment {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'CustomerSchema', required: true, index: true })
  customerId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  amountCents: number;

  @Prop({ type: String, enum: ['cash', 'pix', 'card', 'other'], default: 'cash' })
  method: string;
}

export const CustomerPaymentSchemaFactory = SchemaFactory.createForClass(CustomerPayment);
