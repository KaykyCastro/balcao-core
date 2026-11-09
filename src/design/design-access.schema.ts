import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { DesignStatus } from './design.rules';

/** Um pedido do admin para montar o site de uma loja, a decisão do lojista e a sessão de edição (design.rules.ts). */
@Schema({ collection: 'design_access', timestamps: true })
export class DesignAccess {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  enterpriseId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  adminId: Types.ObjectId;

  @Prop({ required: true })
  adminEmail: string;

  /** Recado do admin ao pedir (o que vai fazer). */
  @Prop({ default: '', maxlength: 500 })
  message: string;

  @Prop({ type: String, required: true, default: 'requested', index: true })
  status: DesignStatus;

  @Prop({ type: Date, default: null }) decidedAt: Date | null;
  /** Até quando a permissão vale (definido quando o lojista permite). */
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
  /** Quantas vezes o rascunho do site foi salvo na sessão. */
  @Prop({ default: 0 }) saves: number;
  /** Quem encerrou: o admin (finalizou), a loja (recusou/revogou) ou o prazo. */
  @Prop({ type: String, default: null }) endedBy: 'admin' | 'store' | 'expired' | null;
}

export type DesignAccessDocument = HydratedDocument<DesignAccess>;
export const DesignAccessSchemaFactory = SchemaFactory.createForClass(DesignAccess);
DesignAccessSchemaFactory.index({ enterpriseId: 1, createdAt: -1 });
