import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type PromotionDocument = HydratedDocument<Promotion>;

/**
 * Promoção de um produto: preço promocional para as primeiras `limitUnits` unidades vendidas.
 * Quando `soldUnits` chega no limite (ou passa `endsAt`, ou é encerrada), o produto volta ao preço normal.
 */
@Schema({ timestamps: true })
export class Promotion {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ProductSchema', required: true })
  productId: Types.ObjectId;

  /** Cópias para o histórico continuar legível se o produto mudar ou for excluído. */
  @Prop({ required: true }) productName: string;
  @Prop({ required: true }) productCode: string;

  @Prop({ required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ type: String, enum: ['price', 'percent'], required: true })
  mode: 'price' | 'percent';

  /** Só em mode = percent (o preço é calculado sobre o preço cheio do produto). */
  @Prop({ type: Number, default: null, min: 1, max: 99 })
  percent: number | null;

  @Prop({ required: true, min: 0 })
  promoPriceCents: number;

  /** Preço cheio do produto quando a promoção foi criada (referência para "de / por"). */
  @Prop({ required: true, min: 0 })
  regularPriceCents: number;

  /** null = sem limite de unidades (vale até o fim ou até ser encerrada). */
  @Prop({ type: Number, default: null, min: 1 })
  limitUnits: number | null;

  @Prop({ required: true, default: 0, min: 0 })
  soldUnits: number;

  @Prop({ type: Date, required: true })
  startsAt: Date;

  @Prop({ type: Date, default: null })
  endsAt: Date | null;

  /** Promoção com vários produtos: todos os itens do grupo têm o mesmo groupId (nome e período em comum). */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  groupId: Types.ObjectId | null;

  /** Encerrada à mão. */
  @Prop({ type: Date, default: null })
  endedAt: Date | null;
}

export const PromotionSchemaFactory = SchemaFactory.createForClass(Promotion);
PromotionSchemaFactory.index({ enterpriseId: 1, productId: 1, endedAt: 1 });
PromotionSchemaFactory.index({ enterpriseId: 1, createdAt: -1 });
