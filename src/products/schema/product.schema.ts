import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, HydratedDocument } from 'mongoose';

export type ProductDocument = HydratedDocument<ProductSchema>;

@Schema({ timestamps: true })
export class ProductSchema {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ required: true, trim: true })
  code: string;

  /** false = estoque ilimitado (serviços, produtos sob demanda): não baixa nem repõe estoque. */
  @Prop({ default: true })
  trackStock: boolean;

  @Prop({ required: true, min: 0, default: 0 })
  quantity: number;

  @Prop({ required: true, min: 0 })
  price: number;

  /** 0/ausente = sem desconto. */
  @Prop({ default: 0, min: 0 })
  priceWithDiscount: number;

  @Prop({ default: 0, min: 0, max: 100 })
  discountPercentage: number;

  @Prop()
  image: string;

  /** Aparece na loja online (quando a loja está ativa). */
  @Prop({ default: true })
  showOnline: boolean;

  /** Peso e medidas da embalagem (frete por transportadora). Vazio = usa a embalagem padrão da loja. */
  @Prop({ type: Number, default: null, min: 0 })
  weightGrams?: number | null;

  @Prop({ type: Number, default: null, min: 0 })
  heightCm?: number | null;

  @Prop({ type: Number, default: null, min: 0 })
  widthCm?: number | null;

  @Prop({ type: Number, default: null, min: 0 })
  lengthCm?: number | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'CategorySchema', required: true, index: true })
  categoryId: Types.ObjectId;
}

export const ProductSchemaFactory = SchemaFactory.createForClass(ProductSchema);
// Código único POR empresa.
ProductSchemaFactory.index({ enterpriseId: 1, code: 1 }, { unique: true });
ProductSchemaFactory.index({ enterpriseId: 1, name: 1 });
ProductSchemaFactory.index({ enterpriseId: 1, showOnline: 1, categoryId: 1 });

/** Preço efetivo de venda (reais): desconto se houver, senão preço cheio. */
export const effectivePrice = (p: { price: number; priceWithDiscount?: number | null }): number =>
  p.priceWithDiscount ? p.priceWithDiscount : p.price;
