import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type StaffDocument = HydratedDocument<Staff>;

/** Funcionário da empresa (caixa, garçom). Entra com código da empresa + usuário + senha, criados pelo dono. */
@Schema({ timestamps: true, collection: 'staff' })
export class Staff {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) enterpriseId: Types.ObjectId;
  @Prop({ required: true, trim: true, maxlength: 60 }) name: string;
  @Prop({ type: String, enum: ['cashier', 'waiter'], required: true }) role: 'cashier' | 'waiter';
  @Prop({ required: true, lowercase: true, trim: true, maxlength: 30 }) username: string;
  @Prop({ required: true, select: false }) passwordHash: string;
  @Prop({ type: [String], default: [] }) permissions: string[];
  @Prop({ default: true }) active: boolean;
  /** Sobe a cada troca de senha, desativação ou "encerrar sessão": derruba o login antigo. */
  @Prop({ default: 0 }) tokenVersion: number;
  @Prop({ default: 0, select: false }) failedLogins: number;
  @Prop({ type: Date, default: null, select: false }) lockUntil: Date | null;
  @Prop({ type: Date, default: null }) lastLoginAt: Date | null;
  /** Horários em que pode acessar (staff.rules.ts: withinSchedule). Sem isso, acessa a qualquer hora. */
  @Prop({ type: Object, default: null }) schedule: { enabled: boolean; windows: { day: number; start: string; end: string }[] } | null;
}
export const StaffSchemaFactory = SchemaFactory.createForClass(Staff);
StaffSchemaFactory.index({ enterpriseId: 1, username: 1 }, { unique: true });

export type ShiftDocument = HydratedDocument<Shift>;
/** Turno de trabalho ("iniciar serviço"). Garçom pode dizer quais mesas está atendendo. */
@Schema({ timestamps: true, collection: 'staff_shifts' })
export class Shift {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) enterpriseId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) staffId: Types.ObjectId;
  @Prop({ required: true }) staffName: string;
  @Prop({ type: String, required: true }) role: 'cashier' | 'waiter';
  @Prop({ type: Date, required: true }) startedAt: Date;
  @Prop({ type: Date, default: null }) endedAt: Date | null;
  @Prop({ default: '' }) endedBy: string;
  @Prop({ type: [Number], default: [] }) tables: number[];
}
export const ShiftSchemaFactory = SchemaFactory.createForClass(Shift);
ShiftSchemaFactory.index({ staffId: 1, endedAt: 1 });
ShiftSchemaFactory.index({ enterpriseId: 1, endedAt: 1, startedAt: -1 });

export type StaffAccessEvent = 'login' | 'login_failed' | 'off_hours' | 'shift_start' | 'shift_end' | 'kicked' | 'disabled';
/** Registro de acessos do colaborador, visível só ao dono. Apagado sozinho depois de 180 dias (dado pessoal: IP). */
@Schema({ collection: 'staff_access_logs' })
export class StaffAccessLog {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) enterpriseId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) staffId: Types.ObjectId;
  @Prop({ required: true }) staffName: string;
  @Prop({ type: String, required: true }) event: StaffAccessEvent;
  @Prop({ default: '' }) detail: string;
  @Prop({ default: '' }) ip: string;
  @Prop({ default: '' }) device: string;
  @Prop({ type: Date, required: true, expires: 180 * 24 * 3600 }) at: Date;
}
export const StaffAccessLogSchema = SchemaFactory.createForClass(StaffAccessLog);
StaffAccessLogSchema.index({ enterpriseId: 1, at: -1 });
StaffAccessLogSchema.index({ enterpriseId: 1, staffId: 1, at: -1 });
