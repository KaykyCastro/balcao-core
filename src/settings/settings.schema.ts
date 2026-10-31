import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** Configurações da plataforma editáveis pelo admin. Um único documento (key = 'billing'). */
@Schema({ timestamps: true, collection: 'platform_settings' })
export class PlatformSettings {
  @Prop({ required: true, unique: true })
  key: string;

  /** Teto da taxa por empresa por mês, em centavos. */
  @Prop({ min: 0 })
  capCents?: number;

  /** Dias de teste grátis para NOVOS cadastros. 0 = sem teste grátis. */
  @Prop({ min: 0 })
  trialDays?: number;

  /** Taxa da loja online quando o cliente vem pelo link da própria loja (basis points: 150 = 1,5%). */
  @Prop({ min: 0 })
  onlineRateBps?: number;

  /** Taxa da loja online quando o cliente chegou pela página "Lojas no Balcão". */
  @Prop({ min: 0 })
  directoryRateBps?: number;

  @Prop()
  updatedBy?: string;
}
export const PlatformSettingsSchemaFactory = SchemaFactory.createForClass(PlatformSettings);
