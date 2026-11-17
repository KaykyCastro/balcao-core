import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

/**
 * Cobrança do Mercado Pago (modo token) que o Balcão consulta sozinho até resolver: pedido da loja online, conta da
 * mesa ou cobrança do caixa (Pix/Point). Uma linha por cobrança; some quando a cobrança resolve ou a janela acaba
 * (TTL de segurança em 2 h). `lockUntil` é a vez de quem está consultando: ninguém consulta a mesma em paralelo.
 * Sem dado pessoal: só ids e horários.
 */
@Schema({ collection: 'mp_polls', timestamps: false })
export class MpPoll {
  @Prop({ type: String, enum: ['order', 'tab', 'pos'], required: true })
  kind: 'order' | 'tab' | 'pos';

  @Prop({ type: Types.ObjectId, required: true })
  refId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  enterpriseId: Types.ObjectId;

  /** Quando a cobrança foi criada (a janela de 30 min conta daqui). */
  @Prop({ type: Date, required: true })
  startedAt: Date;

  @Prop({ type: Date, required: true })
  next: Date;

  @Prop({ default: 0, min: 0 })
  fails: number;

  @Prop({ type: Date, default: null })
  lockUntil: Date | null;

  @Prop({ type: Date, required: true })
  expireAt: Date;
}
export const MpPollSchema = SchemaFactory.createForClass(MpPoll);
MpPollSchema.index({ kind: 1, refId: 1 }, { unique: true });
MpPollSchema.index({ next: 1 });
MpPollSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
