import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * Banner do marketplace "Lojas no Balcão", criado pelo admin.
 * `hero` = carrossel principal do topo (promoções); `middle` = carrossel de anúncios no meio da página.
 * `kind` diz o que é: promoção de lojas ou anúncio do próprio Balcão (aparece com a etiqueta "Balcão").
 */
@Schema({ collection: 'market_banners', timestamps: true })
export class MarketBanner {
  @Prop({ type: String, enum: ['hero', 'middle'], required: true }) placement: 'hero' | 'middle';
  @Prop({ type: String, enum: ['promo', 'balcao'], default: 'promo' }) kind: 'promo' | 'balcao';
  @Prop({ default: '' }) title: string;
  @Prop({ default: '' }) subtitle: string;
  @Prop({ default: '' }) cta: string;
  /** Caminho do próprio site (/lojas?..., /loja/slug) ou https externo. */
  @Prop({ default: '' }) link: string;
  /** Imagem em data URL (servida por /public/market/banners/:id/image) ou https. */
  @Prop({ required: true }) image: string;
  @Prop({ type: String, enum: ['light', 'dark'], default: 'light' }) tone: 'light' | 'dark';
  @Prop({ default: true }) active: boolean;
  @Prop({ type: Date, default: null }) startsAt: Date | null;
  @Prop({ type: Date, default: null }) endsAt: Date | null;
  @Prop({ default: 0 }) order: number;
  updatedAt?: Date;
}
export const MarketBannerSchema = SchemaFactory.createForClass(MarketBanner);
MarketBannerSchema.index({ placement: 1, active: 1, order: 1 });
