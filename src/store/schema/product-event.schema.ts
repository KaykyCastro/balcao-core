import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Interação de um visitante com um produto no marketplace (visualização ou curtida), para recomendar produtos.
 * Só existe quando a pessoa aceitou os cookies de preferências: o identificador é aleatório, criado no navegador,
 * e não leva nome, e-mail nem IP. Apagado sozinho depois de 90 dias.
 */
@Schema({ collection: 'product_events' })
export class ProductEvent {
  @Prop({ required: true, index: true }) visitorId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) productId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) enterpriseId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) categoryId: Types.ObjectId | null;
  @Prop({ type: String, enum: ['view', 'like'], required: true }) kind: 'view' | 'like';
  @Prop({ type: Date, required: true, expires: 90 * 24 * 3600 }) at: Date;
}
export const ProductEventSchema = SchemaFactory.createForClass(ProductEvent);
ProductEventSchema.index({ visitorId: 1, at: -1 });
ProductEventSchema.index({ at: -1, kind: 1 });
// Uma curtida por visitante e produto (descurtir apaga).
ProductEventSchema.index({ visitorId: 1, productId: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: 'like' } });
