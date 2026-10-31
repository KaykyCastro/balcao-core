import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Código de uso único que o app troca por uma sessão (cookie) no navegador embutido.
 * Guardamos só o hash; o Mongo apaga sozinho depois do vencimento (índice TTL).
 */
@Schema({ collection: 'auth_handoffs' })
export class AuthHandoff {
  @Prop({ required: true, unique: true })
  codeHash: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true })
  enterpriseId: Types.ObjectId;

  /** Caminho do Balcão para onde vai depois de entrar (só caminhos da lista permitida). */
  @Prop({ required: true })
  path: string;

  @Prop({ type: Date, required: true, expires: 0 })
  expiresAt: Date;
}
export const AuthHandoffSchema = SchemaFactory.createForClass(AuthHandoff);
