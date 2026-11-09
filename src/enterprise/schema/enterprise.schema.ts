import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EnterpriseDocument = HydratedDocument<EnterpriseSchema>;

@Schema({ _id: false })
export class BillingState {
  /** 'blocked' = fatura vencida sem pagamento: tudo bloqueado, exceto /billing e /auth. */
  @Prop({ type: String, enum: ['active', 'blocked'], default: 'active' })
  status: 'active' | 'blocked';

  @Prop({ type: Date, default: null })
  blockedAt?: Date | null;
}
const BillingStateSchema = SchemaFactory.createForClass(BillingState);

/** Campos que nunca saem na API, em nenhuma serialização. */
const HIDDEN = ['password', 'passwordResetHash', 'passwordResetExpires', 'failedLogins', 'lockUntil', 'tokenVersion', 'googleId', '__v'];
const hide = (_doc: unknown, ret: Record<string, unknown>) => {
  for (const k of HIDDEN) delete ret[k];
  return ret;
};

@Schema({ timestamps: true, toJSON: { transform: hide }, toObject: { transform: hide } })
export class EnterpriseSchema {
  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ required: false, maxlength: 400_000 })
  logo: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop({ required: false })
  cnpj: string;

  /** 'admin' só é concedido por ADMIN_EMAIL/ADMIN_PASSWORD na subida ou por outro admin; nunca pelo cadastro. */
  @Prop({ type: String, enum: ['user', 'admin'], default: 'user', index: true })
  role: 'user' | 'admin';

  /** 'suspended' = bloqueado pelo admin (não entra, nem paga). Diferente de billing.blocked. */
  @Prop({ type: String, enum: ['active', 'suspended'], default: 'active', index: true })
  status: 'active' | 'suspended';

  @Prop({ type: String, default: null, maxlength: 300 })
  suspendedReason?: string | null;

  @Prop({ type: Date, default: null })
  suspendedAt?: Date | null;

  /** Fim do teste grátis (30 dias após o cadastro; o admin pode estender). */
  @Prop({ type: Date, default: null })
  trialEndsAt?: Date | null;

  /** Teto mensal próprio desta empresa (centavos). Vazio = usa o padrão da plataforma. */
  @Prop({ type: Number, default: null, min: 0 })
  feeCapCents?: number | null;

  /** Admin pode isentar uma empresa da taxa. */
  @Prop({ default: false })
  feeExempt: boolean;

  /** Meses grátis dados pelo admin ('YYYY-MM'): nesses meses o uso do Balcão não gera taxa. */
  @Prop({ type: [String], default: [] })
  freeMonths: string[];

  /** Desconto máximo no carrinho para colaboradores, em pontos-base (1000 = 10%). 0 = colaborador não dá desconto. */
  @Prop({ type: Number, default: 1000, min: 0, max: 10_000 })
  staffMaxDiscountBps: number;

  /** Layout da tela de vendas e do comprovante (pdv-layout.rules.ts): o dono escolhe, web, app e colaboradores usam. */
  @Prop({ type: Object, default: null, select: false })
  pdvLayout?: Record<string, unknown> | null;

  @Prop({ type: Date, default: null })
  pdvLayoutUpdatedAt?: Date | null;

  /** Avisos da fatura do sistema: e-mail sempre; WhatsApp só com o número e o "sim" do lojista (data do aceite). */
  @Prop({ type: Object, default: null })
  billingNotify?: { whatsapp: string; whatsappOptInAt: Date | null } | null;

  /**
   * Cobrança automática da fatura no cartão, por assinatura do Mercado Pago (preapproval).
   * O cartão é digitado e guardado no Mercado Pago: aqui só o id da assinatura e o estado dela.
   */
  @Prop({ type: Object, default: null })
  autopay?: { preapprovalId: string; status: string; amountCents: number | null; nextChargeAt: Date | null; updatedAt: Date } | null;

  /** Cores do painel (cor principal e dos gráficos), as mesmas em todo computador e para os colaboradores. null = laranja do Balcão. */
  @Prop({ type: Object, default: null })
  panelTheme?: { accent: string; chart: string } | null;

  /** Taxa do ERP em aberto, em centavos. */
  @Prop({ required: true, default: 0, min: 0 })
  debtCents: number;

  @Prop({ type: BillingStateSchema, default: () => ({ status: 'active' }) })
  billing: BillingState;

  // ---- segurança de sessão
  /** Sobe a cada troca de senha/"sair de todos": invalida os JWT antigos. */
  @Prop({ default: 0, select: false })
  tokenVersion: number;

  @Prop({ default: 0, select: false })
  failedLogins: number;

  @Prop({ type: Date, default: null, select: false })
  lockUntil?: Date | null;

  @Prop({ type: String, default: null, select: false })
  passwordResetHash?: string | null;

  @Prop({ type: Date, default: null, select: false })
  passwordResetExpires?: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt?: Date | null;

  /** Quando o e-mail foi confirmado (código da verificação em duas etapas ou login com Google). */
  @Prop({ type: Date, default: null })
  emailVerifiedAt?: Date | null;

  /** "sub" da conta Google vinculada (login com Google). Nunca sai na API. */
  @Prop({ type: String, default: null, select: false })
  googleId?: string | null;

  /** Aceite dos Termos de Uso no cadastro (data e versão). */
  @Prop({ type: Date, default: null })
  termsAcceptedAt?: Date | null;

  @Prop({ type: String, default: null, maxlength: 10 })
  termsVersion?: string | null;

  /** Versão da Política de Privacidade apresentada no cadastro. */
  @Prop({ type: String, default: null, maxlength: 10 })
  privacyVersion?: string | null;

  /** Código da empresa para o login dos funcionários (ex.: BOTECO42). Criado no primeiro funcionário. */
  @Prop({ type: String, default: null, uppercase: true, trim: true })
  staffCode?: string | null;
}

// (staffCode: ver a propriedade na classe)
export const EnterpriseSchemaFactory = SchemaFactory.createForClass(EnterpriseSchema);
EnterpriseSchemaFactory.index({ staffCode: 1 }, { unique: true, partialFilterExpression: { staffCode: { $type: 'string' } } });
EnterpriseSchemaFactory.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } });
EnterpriseSchemaFactory.index({ createdAt: -1 });
EnterpriseSchemaFactory.index({ name: 1 });
