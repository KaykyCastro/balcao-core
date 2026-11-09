import { encryptedFields } from '../../common/security/field-crypto';
import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShopperDocument = HydratedDocument<Shopper>;

export interface ShopperAddress {
  label: string;
  cep: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
}

/**
 * Conta do comprador (cliente final). Uma conta só vale em todas as lojas do Balcão.
 * Em cada loja onde compra (ou onde o lojista vincula), vira um registro em "Clientes" daquela empresa.
 */
@Schema({ timestamps: true })
export class Shopper {
  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, maxlength: 160 })
  email: string;

  /** Criptografado no banco (field-crypto); o tamanho é validado no DTO. */
  @Prop({ default: '' })
  phone: string;

  /** CPF/CNPJ, criptografado no banco (field-crypto); o tamanho é validado no DTO. */
  @Prop({ default: '' })
  document: string;

  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({ type: [raw({ label: String, cep: String, street: String, number: String, complement: String, district: String, city: String, state: String, _id: false })], default: [] })
  addresses: ShopperAddress[];

  /** E-mail confirmado: só então o lojista pode vincular débitos e os pedidos antigos com esse e-mail aparecem. */
  @Prop({ type: Date, default: null })
  emailVerifiedAt: Date | null;

  @Prop({ type: String, default: null, select: false })
  verifyHash: string | null;

  @Prop({ type: String, default: null, select: false })
  resetHash: string | null;

  @Prop({ type: Date, default: null, select: false })
  resetExpires: Date | null;

  /** Incrementa ao trocar/redefinir senha e no "sair de todos os aparelhos": derruba sessões antigas. */
  @Prop({ default: 0 })
  tokenVersion: number;

  @Prop({ default: 0, select: false })
  failedLogins: number;

  @Prop({ type: Date, default: null, select: false })
  lockUntil: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt: Date | null;

  /** Aceite dos Termos e ciência da Política de Privacidade no cadastro (prova para a LGPD). */
  @Prop(raw({ acceptedAt: Date, termsVersion: String, privacyVersion: String, _id: false }))
  consents: { acceptedAt: Date; termsVersion: string; privacyVersion: string } | null;
}

export const ShopperSchemaFactory = SchemaFactory.createForClass(Shopper);
// Dados pessoais criptografados (telefone, CPF e endereços; cidade e UF ficam abertas para o frete).
ShopperSchemaFactory.plugin(encryptedFields(['phone', 'document', 'addresses[].cep', 'addresses[].street', 'addresses[].number', 'addresses[].complement', 'addresses[].district']));
ShopperSchemaFactory.index({ verifyHash: 1 }, { sparse: true });
ShopperSchemaFactory.index({ resetHash: 1 }, { sparse: true });
