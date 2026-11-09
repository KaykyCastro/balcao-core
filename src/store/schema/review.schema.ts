import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/** Avaliação de um produto por quem comprou (um pedido pago dá direito a uma avaliação por produto). */
@Schema({ collection: 'reviews', timestamps: true })
export class Review {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) enterpriseId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) productId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) orderId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) shopperId: Types.ObjectId | null;
  /** "Ana S." (só primeiro nome e inicial). */
  @Prop({ required: true }) name: string;
  @Prop({ required: true, min: 1, max: 5 }) rating: number;
  @Prop({ default: '' }) text: string;
  @Prop({ type: [String], default: [] }) photos: string[];
  /** Ocultada pelo lojista (some da vitrine e da média). */
  @Prop({ default: false }) hidden: boolean;
  @Prop({ default: '' }) reply: string;
  @Prop({ type: Date, default: null }) repliedAt: Date | null;
  createdAt?: Date;
}
export const ReviewSchema = SchemaFactory.createForClass(Review);
ReviewSchema.index({ orderId: 1, productId: 1 }, { unique: true });
ReviewSchema.index({ enterpriseId: 1, productId: 1, hidden: 1, createdAt: -1 });
