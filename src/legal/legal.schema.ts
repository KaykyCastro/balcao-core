import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import { encryptedFields } from '../common/security/field-crypto';
import { ACCESS_LOG_DAYS, REQUEST_KINDS, REQUEST_STATUSES, REQUESTER_ROLES, RETENTION_YEARS } from './legal.rules';

const YEARS = RETENTION_YEARS * 366 * 86_400;

/**
 * Registro de acesso (Marco Civil, art. 15): quem, de qual IP, quando. Uma linha por pessoa e IP a cada hora de uso.
 * Fica 190 dias, mesmo se a conta for excluída (obrigação legal). Sem enterpriseId de propósito: não é dado da loja,
 * é registro do provedor (e não entra na exclusão nem na guarda de isolamento entre lojas).
 */
@Schema({ collection: 'access_logs' })
export class AccessLog {
  @Prop({ type: String, enum: ['enterprise', 'staff', 'admin', 'shopper'], required: true }) kind: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) subjectId: Types.ObjectId;
  /** Colaborador: a conta da loja a que ele pertence. */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) accountId: Types.ObjectId | null;
  @Prop({ type: String, default: '' }) ip: string;
  @Prop({ type: String, default: '' }) userAgent: string;
  @Prop({ type: Date, required: true }) at: Date;
}
export const AccessLogSchemaFactory = SchemaFactory.createForClass(AccessLog);
AccessLogSchemaFactory.index({ at: 1 }, { expireAfterSeconds: ACCESS_LOG_DAYS * 86_400 });

/** Prova de aceite dos Termos e da Política (cadastro e novos aceites). Fica 5 anos, mesmo após excluir a conta. */
@Schema({ collection: 'consent_logs' })
export class ConsentLog {
  @Prop({ type: String, enum: ['enterprise', 'shopper'], required: true }) kind: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) subjectId: Types.ObjectId;
  @Prop({ type: String, default: '' }) email: string;
  @Prop({ type: String, default: '' }) termsVersion: string;
  @Prop({ type: String, default: '' }) privacyVersion: string;
  @Prop({ type: String, enum: ['register', 'accept'], default: 'register' }) event: string;
  @Prop({ type: Date, required: true }) at: Date;
}
export const ConsentLogSchemaFactory = SchemaFactory.createForClass(ConsentLog);
ConsentLogSchemaFactory.index({ at: 1 }, { expireAfterSeconds: YEARS });
ConsentLogSchemaFactory.plugin(encryptedFields(['email']));

/**
 * Conta de lojista encerrada: o mínimo para as faturas que ficam (obrigação fiscal) continuarem identificáveis e para a
 * defesa em eventual processo. Fica 5 anos.
 */
@Schema({ collection: 'account_closures' })
export class AccountClosure {
  /** A conta que foi encerrada. Não se chama enterpriseId de propósito: a exclusão apaga tudo que tem esse campo. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) accountId: Types.ObjectId;
  @Prop({ type: String, default: '' }) name: string;
  @Prop({ type: String, default: '' }) email: string;
  @Prop({ type: String, default: '' }) document: string;
  @Prop({ type: String, default: '' }) termsVersion: string;
  @Prop({ type: Date, default: null }) termsAcceptedAt: Date | null;
  @Prop({ type: Number, default: 0 }) invoicesKept: number;
  @Prop({ type: Date, required: true }) closedAt: Date;
}
export const AccountClosureSchemaFactory = SchemaFactory.createForClass(AccountClosure);
AccountClosureSchemaFactory.index({ closedAt: 1 }, { expireAfterSeconds: YEARS });
AccountClosureSchemaFactory.plugin(encryptedFields(['email', 'document']));

/** Pedido do titular (LGPD, art. 18). Protocolo, prazo de 15 dias, resposta e histórico. */
@Schema({ collection: 'privacy_requests', timestamps: true })
export class PrivacyRequest {
  @Prop({ type: String, default: '', index: true }) protocol: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) email: string;
  @Prop({ type: String, enum: Object.keys(REQUESTER_ROLES), required: true }) role: string;
  @Prop({ type: String, enum: Object.keys(REQUEST_KINDS), required: true }) kind: string;
  /** Loja citada (cliente de loja): a loja é a controladora e recebe o pedido no painel. */
  @Prop({ type: String, default: '' }) storeSlug: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) storeEnterpriseId: Types.ObjectId | null;
  @Prop({ type: String, default: '' }) details: string;
  @Prop({ type: String, enum: REQUEST_STATUSES, default: 'unverified', index: true }) status: string;
  @Prop({ type: String, default: '', select: false }) codeHash: string;
  @Prop({ type: Date, default: null }) codeExpiresAt: Date | null;
  @Prop({ type: Number, default: 0 }) wrong: number;
  @Prop({ type: Date, default: null }) verifiedAt: Date | null;
  @Prop({ type: Date, default: null, index: true }) dueAt: Date | null;
  @Prop({ type: String, default: '' }) response: string;
  @Prop({ type: Date, default: null }) closedAt: Date | null;
  @Prop({ type: [{ at: Date, status: String, by: String, note: String, _id: false }], default: [] })
  history: { at: Date; status: string; by: string; note: string }[];
  @Prop({ type: String, default: '' }) ip: string;
}
export const PrivacyRequestSchemaFactory = SchemaFactory.createForClass(PrivacyRequest);
PrivacyRequestSchemaFactory.plugin(encryptedFields(['name', 'email', 'details']));
// Pedido respondido fica 5 anos (comprova o atendimento); os em aberto não têm closedAt e não vencem.
PrivacyRequestSchemaFactory.index({ closedAt: 1 }, { expireAfterSeconds: YEARS });
// Pedidos que nunca confirmaram o e-mail somem em 2 dias.
PrivacyRequestSchemaFactory.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 86_400, partialFilterExpression: { status: 'unverified' } });
