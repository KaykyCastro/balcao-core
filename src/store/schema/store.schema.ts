import { BODY_FONT_KEYS, FONT_KEYS } from '../fonts.rules';
import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type StoreDocument = HydratedDocument<Store>;
/** link: '' | '#produtos' | 'cat:<id>' | 'p:<id>' | 'https://...'; align: left|center; tone: light (texto branco) | dark */
export interface StoreSlide { image: string; video?: string; title: string; subtitle: string; cta: string; link: string; align: 'left' | 'center'; tone: 'light' | 'dark' }
/** Vídeo curto ligado a um produto ("vídeos que vendem"). video: 'media:<id>' (enviado) ou https://...mp4 */
export interface StoreReel { video: string; productId: string; title: string }
/** Faixa de benefícios abaixo do topo (frete, Pix, parcelamento...). Texto do lojista. */
export interface StoreHighlight { icon: string; title: string; text: string }

/** Loja online de uma empresa (uma por empresa). */
import type { SitePage } from '../builder.rules';

@Schema({ timestamps: true })
export class Store {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, unique: true })
  enterpriseId: Types.ObjectId;

  /** Loja no ar. Só liga com o Mercado Pago conectado e ao menos uma forma de entrega. */
  @Prop({ default: false, index: true })
  enabled: boolean;

  /** Pausa temporária: a vitrine continua no ar, mas não aceita pedidos. */
  @Prop({ default: false })
  ordersPaused: boolean;

  /**
   * Domínio próprio (ex.: minhaloja.com.br): a loja abre nele, sem o endereço da plataforma. `pending` até o DNS
   * apontar para o Balcão e o TXT de confirmação estar certo (store/domain.service.ts); só `active` abre a loja.
   */
  @Prop(raw({ host: { type: String, default: null, lowercase: true, trim: true }, status: { type: String, enum: ['pending', 'active'], default: 'pending' }, verifiedAt: { type: Date, default: null }, checkedAt: { type: Date, default: null }, error: { type: String, default: '' } }))
  domain: { host: string | null; status: 'pending' | 'active'; verifiedAt: Date | null; checkedAt: Date | null; error: string } | null;

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

  /** Horário de funcionamento, em texto (ex.: "Ter a dom, 18h às 0h"). */
  @Prop({ default: '', maxlength: 120 })
  hours: string;

  /** Banners deslizantes do topo (tema "carousel"). Até 6. */
  @Prop({ type: [{ image: String, video: String, title: String, subtitle: String, cta: String, link: String, align: String, tone: String, _id: false }], default: [] })
  slides: StoreSlide[];

  @Prop(raw({
    accent: { type: String, default: '#FF3D00' },
    background: { type: String, enum: ['light', 'warm', 'dark', 'custom'], default: 'light' },
    /** Fundo 'custom': cor livre; cartões e texto são calculados para manter o contraste. */
    bgColor: { type: String, default: '#ffffff' },
    font: { type: String, enum: [...FONT_KEYS], default: 'modern' },
    bodyFont: { type: String, enum: [...BODY_FONT_KEYS], default: 'modern' },
    corners: { type: String, enum: ['rounded', 'soft', 'square'], default: 'rounded' },
    logoSize: { type: String, enum: ['sm', 'md', 'lg', 'xl'], default: 'md' },
    logoShape: { type: String, enum: ['original', 'rounded', 'circle'], default: 'original' },
    logoName: { type: Boolean, default: true },
    columns: { type: Number, enum: [2, 3, 4], default: 3 },
    hero: { type: String, enum: ['carousel', 'banner', 'simple', 'split', 'duo'], default: 'banner' },
    autoplaySec: { type: Number, default: 5 },
    heroHeight: { type: String, enum: ['compact', 'large'], default: 'large' },
    showStock: { type: Boolean, default: false },
    layout: { type: String, enum: ['classic', 'fashion', 'beauty', 'market', 'menu', 'bistro', 'delivery', 'atelier', 'jewel', 'street', 'boutique', 'retail', 'glow'], default: 'classic' },
    /** Cabeçalho: classic (busca e botão de carrinho) ou editorial (logo, categorias e ícones, como lojas de moda). */
    header: { type: String, enum: ['classic', 'editorial', 'centered', 'split', 'bar'], default: 'classic' },
    /** Parcelas sem juros que a loja oferece (0 = não mostra "ou 6x de..." no preço). */
    installments: { type: Number, default: 0, min: 0, max: 12 },
  }))
  theme: { accent: string; background: 'light' | 'warm' | 'dark' | 'custom'; bgColor: string; font: string; bodyFont: string; corners: 'rounded' | 'soft' | 'square'; logoSize?: 'sm' | 'md' | 'lg' | 'xl'; logoShape?: 'original' | 'rounded' | 'circle'; logoName?: boolean; columns: 2 | 3 | 4; hero: 'carousel' | 'banner' | 'simple' | 'split' | 'duo'; autoplaySec: number; heroHeight: 'compact' | 'large'; showStock: boolean; layout: 'classic' | 'fashion' | 'beauty' | 'market' | 'menu' | 'bistro' | 'delivery' | 'atelier' | 'jewel' | 'street' | 'boutique' | 'retail' | 'glow'; header?: 'classic' | 'editorial' | 'centered' | 'split' | 'bar'; installments?: number };

  @Prop({ type: [{ video: String, productId: String, title: String, _id: false }], default: [] })
  reels: StoreReel[];

  @Prop({ default: '', maxlength: 60 })
  reelsTitle: string;

  @Prop({ type: [{ icon: String, title: String, text: String, _id: false }], default: [] })
  highlights: StoreHighlight[];

  /** Pagar na entrega/retirada (cardápio e loja virtual): formas aceitas. */
  @Prop(raw({ enabled: { type: Boolean, default: false }, methods: { type: [String], default: ['cash', 'card', 'pix'] } }))
  payOnDelivery: { enabled: boolean; methods: string[] };

  /** Como a loja funciona: e-commerce, loja virtual ou cardápio (null = loja antiga; ver modeOf). */
  @Prop({ type: String, enum: ['ecommerce', 'whatsapp', 'catalog', 'menu'], default: null })
  mode: 'ecommerce' | 'whatsapp' | 'catalog' | 'menu' | null;

  /**
   * Site montado pelo lojista no construtor (seções → componentes). `page` é o que está no ar; `pageDraft` é o rascunho
   * que o construtor salva enquanto o lojista edita. Validados por store/builder.rules.ts. Sem página = vitrine padrão.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  page: SitePage | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  pageDraft: SitePage | null;

  @Prop({ type: Date, default: null })
  pagePublishedAt: Date | null;

  /** Aba do navegador e buscadores: título, descrição e favicon próprios. */
  @Prop(raw({ title: { type: String, default: '' }, description: { type: String, default: '' }, favicon: { type: String, default: '' } }))
  seo: { title: string; description: string; favicon: string };

  /**
   * Mesas (modo cardápio): o cliente lê o QR Code da mesa.
   * payment 'tab' = comanda: pede sem pagar e paga no fim, quando o garçom (ou o sistema) libera.
   * payment 'upfront' = paga cada pedido na hora, pelo celular.
   */
  @Prop(raw({
    enabled: { type: Boolean, default: false }, count: { type: Number, default: 10 }, label: { type: String, default: 'Mesa' },
    payment: { type: String, enum: ['tab', 'upfront'], default: 'tab' }, serviceRateBps: { type: Number, default: 0 },
  }))
  tables: { enabled: boolean; count: number; label: string; payment?: 'tab' | 'upfront'; serviceRateBps?: number };

  @Prop(raw({ whatsapp: { type: String, default: '' }, instagram: { type: String, default: '' }, email: { type: String, default: '' } }))
  contacts: { whatsapp: string; instagram: string; email: string };

  @Prop(raw({ exchange: { type: String, default: '' }, shipping: { type: String, default: '' } }))
  policies: { exchange: string; shipping: string };

  /**
   * Quem vende (Decreto 7.962/2013, art. 2º): nome empresarial, CPF/CNPJ, endereço físico e eletrônico.
   * Aparece no rodapé e nas políticas da loja. Obrigatório para ligar a loja.
   */
  @Prop(raw({ name: { type: String, default: '' }, document: { type: String, default: '' }, address: { type: String, default: '' }, email: { type: String, default: '' }, phone: { type: String, default: '' } }))
  legal: { name: string; document: string; address: string; email: string; phone: string };

  /** Conta Mercado Pago do lojista, conectada por OAuth. Tokens cifrados e nunca enviados ao navegador. */
  @Prop(raw({
    userId: { type: String, default: '' }, nickname: { type: String, default: '' }, email: { type: String, default: '' }, publicKey: { type: String, default: '' },
    accessSealed: { type: String, default: null, select: false }, refreshSealed: { type: String, default: null, select: false },
    expiresAt: { type: Date, default: null }, connectedAt: { type: Date, default: null },
  }))
  mp: { userId: string; nickname: string; email: string; publicKey: string; accessSealed?: string | null; refreshSealed?: string | null; expiresAt: Date | null; connectedAt: Date | null };

  @Prop({ default: 0, min: 0 })
  minOrderCents: number;

  /** Cashback da loja: % do que o cliente paga pelos produtos volta como crédito para a próxima compra aqui. */
  @Prop(raw({ enabled: { type: Boolean, default: false }, rateBps: { type: Number, default: 500 }, expiresDays: { type: Number, default: 90 } }))
  cashback: { enabled: boolean; rateBps: number; expiresDays: number };

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
      /** Remetente das etiquetas (endereço completo, como a transportadora pede). */
      sender: {
        name: { type: String, default: '' }, phone: { type: String, default: '' }, email: { type: String, default: '' }, document: { type: String, default: '' },
        street: { type: String, default: '' }, number: { type: String, default: '' }, complement: { type: String, default: '' },
        district: { type: String, default: '' }, city: { type: String, default: '' }, state: { type: String, default: '' },
      },
    },
    package: { weightGrams: { type: Number, default: 300 }, heightCm: { type: Number, default: 4 }, widthCm: { type: Number, default: 20 }, lengthCm: { type: Number, default: 25 } },
  }))
  shipping: any;

  /** Aceite da taxa da loja online (obrigatório para ligar a loja). Guarda os percentuais aceitos. */
  @Prop({ type: Date, default: null })
  feeAcceptedAt: Date | null;

  @Prop(raw({ onlineRateBps: Number, directoryRateBps: Number }))
  feeAcceptedRates?: { onlineRateBps: number; directoryRateBps: number } | null;

  /** Bloqueio pela plataforma (denúncia, dados falsos, descumprimento das regras). Tira a loja do ar e impede religar. */
  @Prop(raw({ at: { type: Date, default: null }, reason: { type: String, default: '' }, by: { type: String, default: '' } }))
  adminBlock?: { at: Date | null; reason: string; by: string } | null;

  /** Número sequencial dos pedidos desta loja (#1001, #1002...). */
  @Prop({ default: 1000 })
  orderSeq: number;

  /** Numeração das comandas (#1, #2...). */
  @Prop({ default: 0 })
  tabSeq: number;
}

export const StoreSchemaFactory = SchemaFactory.createForClass(Store);
StoreSchemaFactory.index({ enabled: 1, listed: 1, segment: 1 });
// Um domínio ativo pertence a uma loja só.
StoreSchemaFactory.index({ 'domain.host': 1 }, { unique: true, partialFilterExpression: { 'domain.status': 'active' } });
