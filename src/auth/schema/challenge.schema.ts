import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Verificação em duas etapas: o código de 6 dígitos enviado por e-mail depois da senha certa.
 * Guardamos só o hash do identificador e o HMAC do código; o Mongo apaga sozinho no vencimento (índice TTL).
 */
@Schema({ collection: 'auth_challenges' })
export class AuthChallenge {
  /** sha256 do identificador opaco que vai para o navegador/app. */
  @Prop({ required: true, unique: true })
  idHash: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  enterpriseId: Types.ObjectId;

  /** HMAC(JWT_SECRET, idHash:código). Sem o segredo do servidor, um vazamento do banco não revela o código. */
  @Prop({ required: true })
  codeHash: string;

  /** 'register' também confirma o e-mail do cadastro. */
  @Prop({ type: String, enum: ['login', 'register'], required: true })
  purpose: 'login' | 'register';

  /** Onde a sessão será aberta: cookie (web) ou token no corpo (app). Um desafio do site não vira token do app. */
  @Prop({ type: String, enum: ['web', 'mobile'], required: true })
  client: 'web' | 'mobile';

  @Prop({ default: 0 })
  attempts: number;


  /** Erros somados em todos os códigos deste desafio (o reenvio zera `attempts`, este não). */

  @Prop({ default: 0 })

  wrongTotal: number;

  @Prop({ default: 1 })
  sends: number;

  @Prop({ type: Date, required: true })
  lastSentAt: Date;

  @Prop({ type: Date, required: true, expires: 0 })
  expiresAt: Date;
}
export const AuthChallengeSchema = SchemaFactory.createForClass(AuthChallenge);
