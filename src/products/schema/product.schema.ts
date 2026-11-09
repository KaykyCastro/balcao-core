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

  /** Foto de capa (= a primeira de `images`). Vai nas listagens; as demais só no detalhe. */
  @Prop()
  image: string;

  /** Todas as fotos, na ordem escolhida (a primeira é a capa). Fora das listagens por padrão: são pesadas. */
  @Prop({ type: [String], default: [], select: false })
  images: string[];

  /** Avaliações dos compradores (média 0 a 5 e quantidade), atualizadas pela ReviewService. */
  @Prop({ default: 0, min: 0, max: 5 })
  ratingAvg: number;
  @Prop({ default: 0, min: 0 })
  ratingCount: number;
  /** Unidades vendidas (balcão e online, vendas não canceladas), recalculadas de hora em hora (SoldCountScheduler). */
  @Prop({ default: 0, min: 0 })
  soldCount: number;

  /** Preço na loja online (reais). Vazio/0 = o mesmo do balcão. */
  @Prop({ type: Number, default: null, min: 0 })
  onlinePrice?: number | null;

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

/** Preço de venda na loja online (reais): o próprio, se o lojista definiu; senão o mesmo do balcão. */
export const onlineEffectivePrice = (p: { price: number; priceWithDiscount?: number | null; onlinePrice?: number | null }): number =>
  p.onlinePrice && p.onlinePrice > 0 ? p.onlinePrice : effectivePrice(p);
