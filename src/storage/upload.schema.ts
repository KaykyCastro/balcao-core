import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Um arquivo no armazenamento (R2). Guarda dono, tipo e tamanho: é daqui que sai a cota por empresa,
 * a prova de que a URL salva num produto é mesmo daquela empresa e a limpeza dos esquecidos.
 * pending = URL de envio entregue; ready = arquivo conferido; attached = usado num produto/loja.
 */
@Schema({ collection: 'uploads', timestamps: true })
export class Upload {
  /** null = arquivo da plataforma (banners do admin). */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true }) enterpriseId: Types.ObjectId | null;
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ required: true }) kind: string;
  @Prop({ required: true }) contentType: string;
  @Prop({ required: true }) size: number;
  @Prop({ type: String, enum: ['pending', 'ready', 'attached'], default: 'pending' }) status: 'pending' | 'ready' | 'attached';
  @Prop({ default: '' }) name: string;
  /** Versões menores da imagem (srcset), apagadas junto com o original. */
  @Prop({ type: [String], default: [] }) variants: string[];
  /** Migração: origem do arquivo ("gridfs:<id>" ou "sha256:<hash>"), para rodar de novo sem duplicar. */
  @Prop({ type: String, default: null }) legacy: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}
export const UploadSchema = SchemaFactory.createForClass(Upload);
UploadSchema.index({ enterpriseId: 1, kind: 1, status: 1 });
UploadSchema.index({ status: 1, updatedAt: 1 });
UploadSchema.index({ enterpriseId: 1, legacy: 1 }, { partialFilterExpression: { legacy: { $type: 'string' } } });
