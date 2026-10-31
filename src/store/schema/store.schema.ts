import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type StoreDocument = HydratedDocument<Store>;

/** Loja online de uma empresa (uma por empresa). */
@Schema({ timestamps: true })
export class Store {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, unique: true })
  enterpriseId: Types.ObjectId;

  /** Loja no ar. Só liga com InfiniteTag e ao menos uma forma de entrega. */
  @Prop({ default: false, index: true })
  enabled: boolean;

  /** Pausa temporária: a vitrine continua no ar, mas não aceita pedidos. */
  @Prop({ default: false })
  ordersPaused: boolean;

  /** Endereço da loja: balcao.app/loja/<slug> */
  @Prop({ required: true, unique: true, lowercase: true, trim: true, maxlength: 40 })
  slug: string;

  @Prop({ required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ default: '', maxlength: 140 })
  tagline: string;

  @Prop({ default: '', maxlength: 1500 })
  about: string;

  @Prop({ default: 'outros', maxlength: 20 })
  segment: string;

  @Prop({ default: '', maxlength: 60 })
  city: string;

  @Prop({ default: '', maxlength: 2 })
  state: string;

  /** Aparece na página "Lojas" do Balcão. */
  @Prop({ default: true })
  listed: boolean;

  /** Logo próprio da loja (vazio = logo da empresa). */
  @Prop({ default: '', maxlength: 400_000 })
  logo: string;

  @Prop({ default: '', maxlength: 900_000 })
  banner: string;

  @Prop({ default: '', maxlength: 160 })
  notice: string;

  @Prop(raw({
    accent: { type: String, default: '#FF3D00' },
    background: { type: String, enum: ['light', 'warm', 'dark'], default: 'light' },
    font: { type: String, enum: ['modern', 'elegant', 'classic'], default: 'modern' },
    corners: { type: String, enum: ['rounded', 'soft', 'square'], default: 'rounded' },
    columns: { type: Number, enum: [2, 3, 4], default: 3 },
    hero: { type: String, enum: ['banner', 'simple', 'split'], default: 'banner' },
    showStock: { type: Boolean, default: false },
  }))
  theme: { accent: string; background: 'light' | 'warm' | 'dark'; font: 'modern' | 'elegant' | 'classic'; corners: 'rounded' | 'soft' | 'square'; columns: 2 | 3 | 4; hero: 'banner' | 'simple' | 'split'; showStock: boolean };

  @Prop(raw({ whatsapp: { type: String, default: '' }, instagram: { type: String, default: '' }, email: { type: String, default: '' } }))
  contacts: { whatsapp: string; instagram: string; email: string };

  @Prop(raw({ exchange: { type: String, default: '' }, shipping: { type: String, default: '' } }))
  policies: { exchange: string; shipping: string };

  /** Conta Mercado Pago do lojista, conectada por OAuth. Tokens cifrados e nunca enviados ao navegador. */
  @Prop(raw({
    userId: { type: String, default: '' }, nickname: { type: String, default: '' }, email: { type: String, default: '' }, publicKey: { type: String, default: '' },
    accessSealed: { type: String, default: null, select: false }, refreshSealed: { type: String, default: null, select: false },
    expiresAt: { type: Date, default: null }, connectedAt: { type: Date, default: null },
  }))
  mp: { userId: string; nickname: string; email: string; publicKey: string; accessSealed?: string | null; refreshSealed?: string | null; expiresAt: Date | null; connectedAt: Date | null };

  @Prop({ default: 0, min: 0 })
  minOrderCents: number;

  @Prop(raw({
    pickup: { enabled: { type: Boolean, default: false }, address: { type: String, default: '' }, instructions: { type: String, default: '' } },
    local: {
      enabled: { type: Boolean, default: false }, name: { type: String, default: 'Entrega da loja' }, priceCents: { type: Number, default: 0 },
      freeAboveCents: { type: Number, default: null }, etaText: { type: String, default: '' },
      cepRanges: { type: [{ from: String, to: String, _id: false }], default: [] },
    },
    fixed: {
      enabled: { type: Boolean, default: false }, name: { type: String, default: 'Envio padrão' }, priceCents: { type: Number, default: 0 },
      freeAboveCents: { type: Number, default: null }, minDays: { type: Number, default: 3 }, maxDays: { type: Number, default: 8 },
    },
    melhorEnvio: {
      enabled: { type: Boolean, default: false }, sandbox: { type: Boolean, default: false }, originCep: { type: String, default: '' },
      handlingDays: { type: Number, default: 1 }, extraFeeCents: { type: Number, default: 0 }, freeAboveCents: { type: Number, default: null },
      tokenSealed: { type: String, default: null, select: false },
      tokenHint: { type: String, default: '' },
    },
    package: { weightGrams: { type: Number, default: 300 }, heightCm: { type: Number, default: 4 }, widthCm: { type: Number, default: 20 }, lengthCm: { type: Number, default: 25 } },
  }))
  shipping: any;

  /** Aceite da taxa da loja online (obrigatório para ligar a loja). Guarda os percentuais aceitos. */
  @Prop({ type: Date, default: null })
  feeAcceptedAt: Date | null;

  @Prop(raw({ onlineRateBps: Number, directoryRateBps: Number }))
  feeAcceptedRates?: { onlineRateBps: number; directoryRateBps: number } | null;

  /** Número sequencial dos pedidos desta loja (#1001, #1002...). */
  @Prop({ default: 1000 })
  orderSeq: number;
}

export const StoreSchemaFactory = SchemaFactory.createForClass(Store);
StoreSchemaFactory.index({ enabled: 1, listed: 1, segment: 1 });
