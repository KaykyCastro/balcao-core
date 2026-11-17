import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Retirada de dinheiro da gaveta (sangria): o lojista tira dinheiro do caixa (comprar algo, levar ao banco) e explica o
 * motivo, para o fechamento bater. Só com a senha do dono. Fica guardada para sempre (sem TTL).
 */
@Schema({ collection: 'cash_withdrawals', timestamps: { createdAt: true, updatedAt: false } })
export class CashWithdrawal {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) enterpriseId: Types.ObjectId;
  /** Dia do caixa (Brasília, AAAA-MM-DD). */
  @Prop({ required: true }) day: string;
  @Prop({ required: true, min: 1 }) amountCents: number;
  @Prop({ required: true, maxlength: 200 }) reason: string;
  /** Quem estava no caixa (o dono ou o colaborador logado). A autorização é sempre a senha do dono. */
  @Prop(raw({ name: String, staffId: { type: MongooseSchema.Types.ObjectId, default: null }, _id: false }))
  by: { name: string; staffId: Types.ObjectId | null };
  createdAt?: Date;
}
export const CashWithdrawalSchema = SchemaFactory.createForClass(CashWithdrawal);
CashWithdrawalSchema.index({ enterpriseId: 1, day: 1, createdAt: 1 });
