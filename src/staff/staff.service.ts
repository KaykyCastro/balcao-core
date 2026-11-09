import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { Shift, ShiftDocument, Staff, StaffAccessLog, StaffDocument, type StaffAccessEvent } from './schema/staff.schema';
import { nextOpening, normalizeSchedule, ROLE_DEFAULT, STAFF_PERMS, withinSchedule, workedMs, type StaffRole, type StaffSchedule } from './staff.rules';
import { StaffCreateDto, StaffUpdateDto } from './dto/staff.dto';
import { Sale } from '../sale/schema/sale.schema';
import { isDuplicateKeyError } from '../common/mongo';
import { DUMMY_HASH } from '../enterprise/enterprise.service';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
/** Funcionário logado (vai em req.user.staff). */
export interface StaffSession {
  id: string; name: string; role: StaffRole; permissions: string[]; shiftId: string | null; tables: number[];
  /** Fora do horário de acesso definido pelo dono: o StaffGuard bloqueia quase tudo. */
  offHours?: boolean; nextAccess?: string | null;
}
/** Quem e de onde, para o registro de acessos. */
export interface AccessCtx { ip?: string; device?: string }
const offHoursMsg = (next: string | null) => `Fora do seu horário de acesso.${next ? ` Seu próximo horário: ${next}.` : ' Fale com o responsável pela loja.'}`;

const codeBase = (name: string) => (name.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6) || 'LOJA');

@Injectable()
export class StaffService {
  constructor(
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
    @InjectModel(Shift.name) private readonly shifts: Model<Shift>,
    @InjectModel('EnterpriseSchema') private readonly enterprises: Model<{ name: string; staffCode?: string | null; status: string; tokenVersion?: number }>,
    @InjectModel(Sale.name) private readonly sales: Model<Sale>,
    @InjectModel(StaffAccessLog.name) private readonly logs?: Model<StaffAccessLog>,
  ) {}

  /** Nunca derruba a operação por causa do registro. */
  private async log(eid: Types.ObjectId | string, s: { _id: unknown; name: string }, event: StaffAccessEvent, ctx: AccessCtx = {}, detail = '') {
    try {
      await this.logs?.create({ enterpriseId: new Types.ObjectId(String(eid)), staffId: new Types.ObjectId(String(s._id)), staffName: s.name, event, detail: detail.slice(0, 200), ip: (ctx.ip ?? '').slice(0, 64), device: (ctx.device ?? '').slice(0, 160), at: new Date() });
    } catch { /* registro é auxiliar */ }
  }

  // ------------------------------------------------------------------ código da empresa

  async code(eid: string): Promise<string> {
    const e = await this.enterprises.findById(eid).select('name staffCode').lean();
    if (!e) throw new NotFoundException('Empresa não encontrada');
    if (e.staffCode) return e.staffCode;
    for (let i = 0; i < 8; i++) {
      const code = `${codeBase(e.name)}${randomInt(10, 99)}`;
      try {
        const r = await this.enterprises.findOneAndUpdate({ _id: eid, staffCode: null }, { $set: { staffCode: code } }, { new: true }).lean();
        return r?.staffCode ?? (await this.enterprises.findById(eid).lean())!.staffCode!;
      } catch (err) { if (!isDuplicateKeyError(err)) throw err; }
    }
    throw new ConflictException('Não foi possível gerar o código da empresa. Tente de novo.');
  }

  // ------------------------------------------------------------------ dono: equipe

  private present(s: StaffDocument | (Staff & { _id: Types.ObjectId }), shift?: ShiftDocument | null) {
    return {
      id: String(s._id), name: s.name, role: s.role, username: s.username, permissions: s.permissions, active: s.active,
      lastLoginAt: s.lastLoginAt ?? null, createdAt: (s as unknown as { createdAt?: Date }).createdAt ?? null,
      schedule: s.schedule ?? { enabled: false, windows: [] }, allowedNow: withinSchedule(s.schedule), nextAccess: withinSchedule(s.schedule) ? null : nextOpening(s.schedule),
      onDuty: shift ? { id: String(shift._id), startedAt: shift.startedAt, tables: shift.tables } : null,
    };
  }

  async list(eid: string) {
    const eoid = new Types.ObjectId(eid);
    const [items, open, code] = await Promise.all([
      this.staff.find({ enterpriseId: eoid }).sort({ active: -1, name: 1 }),
      this.shifts.find({ enterpriseId: eoid, endedAt: null }),
      this.code(eid),
    ]);
    const byStaff = new Map(open.map((s) => [String(s.staffId), s]));
    return { code, items: items.map((s) => this.present(s, byStaff.get(String(s._id)))) };
  }

  private perms(role: StaffRole, list?: string[]) {
    const p = list ?? ROLE_DEFAULT[role];
    return [...new Set(p.filter((x) => (STAFF_PERMS as readonly string[]).includes(x)))];
  }

  async create(eid: string, dto: StaffCreateDto) {
    try {
      const s = await this.staff.create({
        enterpriseId: new Types.ObjectId(eid), name: dto.name.trim(), role: dto.role, username: dto.username.toLowerCase(),
        passwordHash: await bcrypt.hash(dto.password, 10), permissions: this.perms(dto.role, dto.permissions), active: true,
        schedule: dto.schedule ? normalizeSchedule(dto.schedule) : null,
      });
      return { ...this.present(s), code: await this.code(eid) };
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Esse usuário já existe entre os seus colaboradores. Escolha outro.');
      throw e;
    }
  }

  private async mine(eid: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Colaborador não encontrado');
    const s = await this.staff.findOne({ _id: id, enterpriseId: new Types.ObjectId(eid) });
    if (!s) throw new NotFoundException('Colaborador não encontrado');
    return s;
  }

  async update(eid: string, id: string, dto: StaffUpdateDto) {
    const s = await this.mine(eid, id);
    const set: Record<string, unknown> = {};
    let kick = false;
    if (dto.name !== undefined) set.name = dto.name.trim();
    if (dto.role !== undefined) set.role = dto.role;
    if (dto.username !== undefined && dto.username !== s.username) { set.username = dto.username.toLowerCase(); kick = true; }
    if (dto.permissions !== undefined) set.permissions = this.perms(dto.role ?? s.role, dto.permissions);
    if (dto.password) { set.passwordHash = await bcrypt.hash(dto.password, 10); set.failedLogins = 0; set.lockUntil = null; kick = true; }
    if (dto.active !== undefined) { set.active = dto.active; if (!dto.active) kick = true; }
    if (dto.schedule !== undefined) set.schedule = normalizeSchedule(dto.schedule as StaffSchedule);
    try {
      await this.staff.updateOne({ _id: s._id }, { $set: set, ...(kick ? { $inc: { tokenVersion: 1 } } : {}) });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Esse usuário já existe entre os seus colaboradores. Escolha outro.');
      throw e;
    }
    if (dto.active === false) { await this.endOpen(s._id, 'dono (desativou)'); await this.log(eid, s, 'disabled'); }
    const after = (await this.staff.findById(s._id))!;
    return this.present(after, await this.shifts.findOne({ staffId: s._id, endedAt: null }));
  }

  /** Derruba o login do funcionário agora (ex.: celular perdido) e encerra o turno aberto. */
  async kick(eid: string, id: string) {
    const s = await this.mine(eid, id);
    await this.staff.updateOne({ _id: s._id }, { $inc: { tokenVersion: 1 } });
    await this.endOpen(s._id, 'dono (encerrou a sessão)');
    await this.log(eid, s, 'kicked');
    return this.present((await this.staff.findById(s._id))!);
  }

  private async endOpen(staffId: Types.ObjectId, by: string) {
    await this.shifts.updateMany({ staffId, endedAt: null }, { $set: { endedAt: new Date(), endedBy: by } });
  }

  /** Turnos (mais recentes primeiro) com o que foi vendido em cada um. */
  async shiftHistory(eid: string, staffId?: string) {
    const f: Record<string, unknown> = { enterpriseId: new Types.ObjectId(eid) };
    if (staffId) f.staffId = new Types.ObjectId(staffId);
    const rows = await this.shifts.find(f).sort({ startedAt: -1 }).limit(60);
    return Promise.all(rows.map(async (s) => ({ id: String(s._id), staffId: String(s.staffId), staffName: s.staffName, role: s.role, startedAt: s.startedAt, endedAt: s.endedAt, endedBy: s.endedBy, tables: s.tables, ...(await this.totals(s)) })));
  }

  private async totals(s: ShiftDocument) {
    const [agg] = await this.sales.aggregate<{ count: number; cents: number }>([
      { $match: { enterpriseId: s.enterpriseId, 'staff.id': s.staffId, status: 'completed', createdAt: { $gte: s.startedAt, ...(s.endedAt ? { $lte: s.endedAt } : {}) } } },
      { $group: { _id: null, count: { $sum: 1 }, cents: { $sum: '$totalCents' } } },
    ]);
    return { salesCount: agg?.count ?? 0, salesCents: agg?.cents ?? 0 };
  }

  // ------------------------------------------------------------------ login do funcionário

  async validateLogin(codeRaw: string, usernameRaw: string, password: string, ctx: AccessCtx = {}) {
    const code = String(codeRaw).trim().toUpperCase();
    const username = String(usernameRaw).trim().toLowerCase();
    const ent = /^[A-Z]{1,8}\d{2}$/.test(code) ? await this.enterprises.findOne({ staffCode: code }).select('+tokenVersion') : null;
    const s = ent ? await this.staff.findOne({ enterpriseId: ent._id, username }).select('+passwordHash +failedLogins +lockUntil') : null;
    if (!ent || !s) { await bcrypt.compare(password, DUMMY_HASH); return null; }
    if (s.lockUntil && s.lockUntil > new Date()) throw new HttpException({ statusCode: 429, code: 'LOGIN_LOCKED', message: 'Muitas tentativas. Tente de novo em alguns minutos.' }, HttpStatus.TOO_MANY_REQUESTS);
    if (!(await bcrypt.compare(password, s.passwordHash))) {
      const fails = (s.failedLogins ?? 0) + 1;
      await this.staff.updateOne({ _id: s._id }, { $set: { failedLogins: fails >= MAX_FAILURES ? 0 : fails, lockUntil: fails >= MAX_FAILURES ? new Date(Date.now() + LOCK_MS) : null } });
      await this.log(ent._id, s, 'login_failed', ctx, fails >= MAX_FAILURES ? 'senha errada (bloqueado por 15 min)' : 'senha errada');
      return null;
    }
    if (!s.active) throw new ForbiddenException({ statusCode: 403, code: 'STAFF_INACTIVE', message: 'Seu acesso foi desativado. Fale com o responsável pela loja.' });
    if (ent.status === 'suspended') throw new ForbiddenException({ statusCode: 403, code: 'ACCOUNT_SUSPENDED', message: 'Conta suspensa. Fale com o suporte.' });
    if (!withinSchedule(s.schedule)) {
      const next = nextOpening(s.schedule);
      await this.log(ent._id, s, 'off_hours', ctx, 'tentou entrar fora do horário');
      throw new ForbiddenException({ statusCode: 403, code: 'STAFF_OFF_HOURS', message: offHoursMsg(next), nextAccess: next });
    }
    await this.staff.updateOne({ _id: s._id }, { $set: { failedLogins: 0, lockUntil: null, lastLoginAt: new Date() } });
    await this.log(ent._id, s, 'login', ctx);
    return { enterpriseId: String(ent._id), enterpriseTv: ent.tokenVersion ?? 0, staff: s };
  }

  /** A cada requisição: confere se o login ainda vale e traz permissões e turno atualizados. */
  async forAuth(eid: string, staffId: string, stv: number): Promise<StaffSession | null> {
    if (!Types.ObjectId.isValid(staffId)) return null;
    const s = await this.staff.findOne({ _id: staffId, enterpriseId: new Types.ObjectId(eid) }).lean();
    if (!s || !s.active || (s.tokenVersion ?? 0) !== stv) return null;
    const sh = await this.shifts.findOne({ staffId: s._id, endedAt: null }).lean();
    const allowed = withinSchedule(s.schedule);
    return { id: String(s._id), name: s.name, role: s.role, permissions: s.permissions, shiftId: sh ? String(sh._id) : null, tables: sh?.tables ?? [], ...(allowed ? {} : { offHours: true, nextAccess: nextOpening(s.schedule) }) };
  }

  // ------------------------------------------------------------------ turno

  async me(eid: string, st: StaffSession) {
    const sh = st.shiftId ? await this.shifts.findById(st.shiftId) : null;
    return { ...st, shift: sh ? { id: String(sh._id), startedAt: sh.startedAt, tables: sh.tables, ...(await this.totals(sh)) } : null, code: await this.code(eid) };
  }

  async startShift(eid: string, st: StaffSession, tables: number[] = []) {
    const open = await this.shifts.findOne({ staffId: new Types.ObjectId(st.id), endedAt: null });
    if (open) return this.me(eid, { ...st, shiftId: String(open._id) });
    const sh = await this.shifts.create({ enterpriseId: new Types.ObjectId(eid), staffId: new Types.ObjectId(st.id), staffName: st.name, role: st.role, startedAt: new Date(), tables: [...new Set(tables)].sort((a, b) => a - b) });
    await this.log(eid, { _id: st.id, name: st.name }, 'shift_start');
    return this.me(eid, { ...st, shiftId: String(sh._id), tables: sh.tables });
  }

  async setTables(eid: string, st: StaffSession, tables: number[]) {
    if (!st.shiftId) throw new ConflictException('Inicie o serviço antes');
    await this.shifts.updateOne({ _id: st.shiftId }, { $set: { tables: [...new Set(tables)].sort((a, b) => a - b) } });
    return this.me(eid, st);
  }

  async endShift(eid: string, st: StaffSession) {
    if (!st.shiftId) return this.me(eid, st);
    const sh = await this.shifts.findOneAndUpdate({ _id: st.shiftId, endedAt: null }, { $set: { endedAt: new Date(), endedBy: st.name } }, { new: true });
    if (sh) await this.log(eid, { _id: st.id, name: st.name }, 'shift_end', {}, st.offHours ? 'encerrado fora do horário' : '');
    return { ended: sh ? { startedAt: sh.startedAt, endedAt: sh.endedAt, ...(await this.totals(sh)) } : null };
  }

  // ------------------------------------------------------------------ dono: desempenho e acessos

  /**
   * Desempenho de cada colaborador no período: vendas, ticket médio, itens, cancelamentos, formas de pagamento,
   * horas em serviço (turnos) e vendas por hora. Só o dono acessa (/staff é recusado para colaboradores).
   */
  async metrics(eid: string, days = 30) {
    const eoid = new Types.ObjectId(eid);
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 3600_000);
    const [people, sales, pays, shifts] = await Promise.all([
      this.staff.find({ enterpriseId: eoid }).sort({ active: -1, name: 1 }).lean(),
      this.sales.aggregate<{ _id: { st: Types.ObjectId; status: string }; count: number; cents: number; items: number }>([
        { $match: { enterpriseId: eoid, 'staff.id': { $exists: true }, createdAt: { $gte: since } } },
        { $group: { _id: { st: '$staff.id', status: '$status' }, count: { $sum: 1 }, cents: { $sum: '$totalCents' }, items: { $sum: { $sum: '$items.quantity' } } } },
      ]),
      this.sales.aggregate<{ _id: { st: Types.ObjectId; m: string }; cents: number; count: number }>([
        { $match: { enterpriseId: eoid, 'staff.id': { $exists: true }, status: 'completed', createdAt: { $gte: since } } },
        { $group: { _id: { st: '$staff.id', m: '$paymentMethod' }, cents: { $sum: '$totalCents' }, count: { $sum: 1 } } },
      ]),
      this.shifts.find({ enterpriseId: eoid, startedAt: { $lt: now }, $or: [{ endedAt: null }, { endedAt: { $gte: since } }] }).select('staffId startedAt endedAt').lean(),
    ]);
    const key = (id: unknown) => String(id);
    const items = people.map((p) => {
      const k = key(p._id);
      const done = sales.find((x) => key(x._id.st) === k && x._id.status === 'completed');
      const canc = sales.find((x) => key(x._id.st) === k && x._id.status === 'cancelled');
      const mine = shifts.filter((x) => key(x.staffId) === k);
      const ms = workedMs(mine, since, now);
      const hours = ms / 3600_000;
      const cents = done?.cents ?? 0, count = done?.count ?? 0;
      return {
        id: k, name: p.name, role: p.role, active: p.active,
        salesCount: count, salesCents: cents, avgTicketCents: count ? Math.round(cents / count) : 0, itemsSold: done?.items ?? 0,
        cancelledCount: canc?.count ?? 0, cancelledCents: canc?.cents ?? 0,
        byPayment: pays.filter((x) => key(x._id.st) === k).map((x) => ({ method: x._id.m, cents: x.cents, count: x.count })).sort((a, b) => b.cents - a.cents),
        shifts: mine.length, workedMinutes: Math.round(ms / 60_000), centsPerHour: hours >= 0.25 ? Math.round(cents / hours) : null,
        onDuty: mine.some((x) => !x.endedAt), lastLoginAt: p.lastLoginAt ?? null,
      };
    });
    const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((a, i) => a + f(i), 0);
    return { days, since, totals: { salesCount: sum((i) => i.salesCount), salesCents: sum((i) => i.salesCents), workedMinutes: sum((i) => i.workedMinutes), cancelledCount: sum((i) => i.cancelledCount) }, items };
  }

  /** Registro de acessos (mais recentes primeiro), 50 por página. */
  async accessLog(eid: string, q: { staffId?: string; page?: number }) {
    const f: Record<string, unknown> = { enterpriseId: new Types.ObjectId(eid) };
    if (q.staffId) f.staffId = new Types.ObjectId(q.staffId);
    const page = q.page ?? 1, limit = 50;
    if (!this.logs) return { items: [], total: 0, page, limit };
    const [rows, total] = await Promise.all([this.logs.find(f).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.logs.countDocuments(f)]);
    return { items: rows.map((r) => ({ id: String(r._id), staffId: String(r.staffId), staffName: r.staffName, event: r.event, detail: r.detail, ip: r.ip, device: r.device, at: r.at })), total, page, limit };
  }

  /** Garçons em serviço e as mesas de cada um (para mandar o chamado ao garçom certo). */
  async waitersOnDuty(eid: string) {
    const rows = await this.shifts.find({ enterpriseId: new Types.ObjectId(eid), endedAt: null, role: 'waiter' }).lean();
    return rows.map((r) => ({ id: String(r.staffId), name: r.staffName, tables: r.tables }));
  }
}
