import { Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import { nextOpening, normalizeSchedule, staffAccess, withinSchedule, workedMs } from './staff.rules';
import { StaffGuard } from './staff.guard';
import { StaffService } from './staff.service';

describe('funcionários: o que cada um acessa', () => {
  const cashier = ['sales', 'customers'], waiter = ['tables'];
  it('caixa vende e vê produtos, mas não mexe no estoque', () => {
    expect(staffAccess('POST', '/sale', cashier).ok).toBe(true);
    expect(staffAccess('GET', '/product', cashier).ok).toBe(true);
    expect(staffAccess('PUT', '/product/abc', cashier).ok).toBe(false);
    expect(staffAccess('POST', '/category', cashier).ok).toBe(false);
    expect(staffAccess('POST', '/promotion', cashier).ok).toBe(false);
    expect(staffAccess('POST', '/product', [...cashier, 'stock']).ok).toBe(true); // dono liberou o estoque
  });
  it('garçom só mesas; ninguém mexe em equipe, configurações, faturas ou admin', () => {
    expect(staffAccess('POST', '/tabs/x/release', waiter).ok).toBe(true);
    expect(staffAccess('POST', '/sale', waiter).ok).toBe(false);
    expect(staffAccess('POST', '/pos/charges', waiter).ok).toBe(true); // cobra a conta na maquininha
    for (const [m, p] of [['GET', '/staff'], ['PUT', '/store-config'], ['PUT', '/pos/config'], ['GET', '/admin/metrics'], ['POST', '/auth/change-password'], ['GET', '/billing/invoices']]) {
      expect(staffAccess(m, p, ['sales', 'tables', 'orders', 'stock', 'customers', 'reports']).ok).toBe(false);
    }
  });
  it('sem turno aberto, só a sessão e o "iniciar serviço"', () => {
    const g = new StaffGuard();
    const ctx = (method: string, path: string, staff: any) => ({ switchToHttp: () => ({ getRequest: () => ({ method, path, user: { staff } }) }) }) as any;
    const off = { id: '1', name: 'Ana', role: 'cashier', permissions: ['sales'], shiftId: null, tables: [] };
    expect(g.canActivate(ctx('GET', '/staff/me', off))).toBe(true);
    expect(g.canActivate(ctx('POST', '/staff/shift/start', off))).toBe(true);
    expect(() => g.canActivate(ctx('POST', '/sale', off))).toThrow(ForbiddenException);
    expect(g.canActivate(ctx('POST', '/sale', { ...off, shiftId: 's1' }))).toBe(true);
    expect(g.canActivate(ctx('PUT', '/store-config', undefined))).toBe(true); // dono não passa por aqui
  });
});

describe('funcionários: cadastro e login', () => {
  function setup() {
    const ent = { _id: new Types.ObjectId(), name: 'Boteco do Porto', staffCode: null as string | null, status: 'active', tokenVersion: 0 };
    const rows: any[] = [];
    const q = (v: any) => { const p: any = Promise.resolve(v); p.select = () => p; p.lean = () => p; p.sort = () => p; p.limit = () => p; return p; };
    const staff: any = {
      create: jest.fn(async (d: any) => { if (rows.some((r) => r.username === d.username)) throw Object.assign(new Error('dup'), { code: 11000 }); const r = { _id: new Types.ObjectId(), tokenVersion: 0, failedLogins: 0, lockUntil: null, ...d }; rows.push(r); return r; }),
      findOne: jest.fn((f: any) => q(rows.find((r) => (!f.username || r.username === f.username) && (!f._id || String(r._id) === String(f._id))) ?? null)),
      findById: jest.fn((id: any) => q(rows.find((r) => String(r._id) === String(id)))),
      updateOne: jest.fn(async (f: any, u: any) => { const r = rows.find((x) => String(x._id) === String(f._id)); Object.assign(r, u.$set ?? {}); if (u.$inc?.tokenVersion) r.tokenVersion++; }),
    };
    const shifts: any = { findOne: jest.fn(() => q(null)), updateMany: jest.fn() };
    const enterprises: any = {
      findById: jest.fn(() => q(ent)),
      findOneAndUpdate: jest.fn((_f: any, u: any) => { ent.staffCode = u.$set.staffCode; return q(ent); }),
      findOne: jest.fn((f: any) => q(f.staffCode === ent.staffCode ? ent : null)),
    };
    const logs: any = { create: jest.fn(async (d: any) => d) };
    return { svc: new StaffService(staff, shifts, enterprises, {} as any, logs), rows, ent, logs };
  }
  it('cria com código da empresa, senha guardada só como hash e permissões do cargo', async () => {
    const t = setup();
    const r = await t.svc.create(String(t.ent._id), { name: 'João', role: 'waiter', username: 'joao', password: 'segredo1' });
    expect(r).toMatchObject({ name: 'João', role: 'waiter', permissions: ['tables'], code: expect.stringMatching(/^BOTECO\d{2}$/) });
    expect(t.rows[0].passwordHash).not.toBe('segredo1');
    await expect(t.svc.create(String(t.ent._id), { name: 'Outro', role: 'cashier', username: 'joao', password: 'segredo2' })).rejects.toThrow(/já existe/);
  });
  it('login com código + usuário + senha; desativado não entra; trocar a senha derruba a sessão', async () => {
    const t = setup();
    const c = await t.svc.create(String(t.ent._id), { name: 'Ana', role: 'cashier', username: 'ana', password: 'segredo1' });
    expect(await t.svc.validateLogin(c.code.toLowerCase(), 'ANA', 'errada')).toBeNull();
    const ok = await t.svc.validateLogin(c.code, 'ana', 'segredo1');
    expect(ok?.staff.name).toBe('Ana');
    expect(await t.svc.forAuth(String(t.ent._id), c.id, 0)).toMatchObject({ name: 'Ana', permissions: ['sales', 'customers'], shiftId: null });
    await t.svc.update(String(t.ent._id), c.id, { password: 'novasenha' });
    expect(await t.svc.forAuth(String(t.ent._id), c.id, 0)).toBeNull(); // token antigo não vale mais
    await t.svc.update(String(t.ent._id), c.id, { active: false });
    await expect(t.svc.validateLogin(c.code, 'ana', 'novasenha')).rejects.toThrow(/desativado/);
  });
});

describe('colaboradores: horários de acesso', () => {
  // Datas em UTC; a loja usa o horário de Brasília (UTC-3).
  const MON_10 = new Date('2026-11-02T13:00:00Z'); // segunda, 10:00
  const TUE_0130 = new Date('2026-11-03T04:30:00Z'); // terça, 01:30
  const SAT_20 = new Date('2026-11-07T23:00:00Z'); // sábado, 20:00
  const weekdays = { enabled: true, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '18:00' })) };

  it('sem horário definido (ou desligado) acessa a qualquer hora', () => {
    expect(withinSchedule(null, SAT_20)).toBe(true);
    expect(withinSchedule({ enabled: false, windows: [] }, SAT_20)).toBe(true);
  });
  it('dentro e fora da faixa; ligado e sem faixa nenhuma = nunca', () => {
    expect(withinSchedule(weekdays, MON_10)).toBe(true);
    expect(withinSchedule(weekdays, SAT_20)).toBe(false);
    expect(withinSchedule({ enabled: true, windows: [] }, MON_10)).toBe(false);
  });
  it('faixa que vira a meia-noite (bar das 18:00 às 02:00 de segunda)', () => {
    const night = { enabled: true, windows: [{ day: 1, start: '18:00', end: '02:00' }] };
    expect(withinSchedule(night, TUE_0130)).toBe(true); // ainda é o turno de segunda
    expect(withinSchedule(night, MON_10)).toBe(false);
  });
  it('próximo horário para a mensagem de bloqueio', () => {
    expect(nextOpening(weekdays, SAT_20)).toBe('seg às 08:00');
    expect(nextOpening(weekdays, new Date('2026-11-02T10:00:00Z'))).toBe('hoje às 08:00'); // segunda 07:00
    expect(nextOpening({ enabled: true, windows: [] }, MON_10)).toBeNull();
  });
  it('normaliza: descarta faixa inválida ou repetida e ordena', () => {
    const n = normalizeSchedule({ enabled: true, windows: [{ day: 2, start: '08:00', end: '12:00' }, { day: 9, start: '08:00', end: '12:00' }, { day: 1, start: '10:00', end: '10:00' }, { day: 2, start: '08:00', end: '12:00' }, { day: 1, start: '08:00', end: '12:00' }] });
    expect(n.windows).toEqual([{ day: 1, start: '08:00', end: '12:00' }, { day: 2, start: '08:00', end: '12:00' }]);
  });
  it('fora do horário o guard só deixa ver o aviso, sair e encerrar o turno', () => {
    const g = new StaffGuard();
    const ctx = (method: string, path: string, staff: any) => ({ switchToHttp: () => ({ getRequest: () => ({ method, path, user: { staff } }) }) }) as any;
    const off = { id: '1', name: 'Ana', role: 'cashier', permissions: ['sales'], shiftId: 's1', tables: [], offHours: true, nextAccess: 'seg às 08:00' };
    for (const [m, p] of [['GET', '/auth/me'], ['POST', '/auth/logout'], ['GET', '/staff/me'], ['POST', '/staff/shift/end']]) expect(g.canActivate(ctx(m, p, off))).toBe(true);
    expect(() => g.canActivate(ctx('POST', '/sale', off))).toThrow(/Fora do seu horário.*seg às 08:00/);
    expect(() => g.canActivate(ctx('POST', '/staff/shift/start', off))).toThrow(ForbiddenException);
  });
  it('desempenho e registro de acessos são só do dono', () => {
    const all = ['sales', 'tables', 'orders', 'stock', 'customers', 'reports'];
    expect(staffAccess('GET', '/staff/metrics', all).ok).toBe(false);
    expect(staffAccess('GET', '/staff/access-log', all).ok).toBe(false);
  });
  it('horas trabalhadas: recorta o turno no início do período e conta o aberto até agora', () => {
    const now = new Date('2026-11-05T12:00:00Z'), since = new Date('2026-11-05T00:00:00Z');
    const ms = workedMs([
      { startedAt: new Date('2026-11-04T22:00:00Z'), endedAt: new Date('2026-11-05T02:00:00Z') }, // 2 h dentro
      { startedAt: new Date('2026-11-05T10:00:00Z'), endedAt: null }, // aberto: 2 h
      { startedAt: new Date('2026-11-01T10:00:00Z'), endedAt: new Date('2026-11-01T12:00:00Z') }, // fora
    ], since, now);
    expect(ms).toBe(4 * 3600_000);
  });
});

describe('colaboradores: login fora do horário e registro de acessos', () => {
  function setup2() {
    const ent = { _id: new Types.ObjectId(), name: 'Boteco', staffCode: 'BOTECO42', status: 'active', tokenVersion: 0 };
    const q = (v: any) => { const p: any = Promise.resolve(v); p.select = () => p; p.lean = () => p; return p; };
    const person: any = { _id: new Types.ObjectId(), name: 'Ana', username: 'ana', active: true, failedLogins: 0, lockUntil: null, passwordHash: '' };
    const staff: any = { findOne: jest.fn(() => q(person)), updateOne: jest.fn(async () => undefined) };
    const enterprises: any = { findOne: jest.fn(() => q(ent)) };
    const logs: any = { create: jest.fn(async (d: any) => d) };
    return { svc: new StaffService(staff, {} as any, enterprises, {} as any, logs), person, logs };
  }
  it('senha certa fora do horário: recusa com o próximo horário e registra a tentativa', async () => {
    const t = setup2();
    t.person.passwordHash = await require('bcrypt').hash('segredo1', 4);
    t.person.schedule = { enabled: true, windows: [] };
    await expect(t.svc.validateLogin('BOTECO42', 'ana', 'segredo1', { ip: '1.2.3.4', device: 'Chrome' })).rejects.toMatchObject({ response: { code: 'STAFF_OFF_HOURS' } });
    expect(t.logs.create).toHaveBeenCalledWith(expect.objectContaining({ event: 'off_hours', ip: '1.2.3.4', device: 'Chrome' }));
  });
  it('senha errada e login certo ficam no registro', async () => {
    const t = setup2();
    t.person.passwordHash = await require('bcrypt').hash('segredo1', 4);
    expect(await t.svc.validateLogin('BOTECO42', 'ana', 'errada')).toBeNull();
    expect(t.logs.create).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'login_failed', staffName: 'Ana' }));
    expect(await t.svc.validateLogin('BOTECO42', 'ana', 'segredo1')).not.toBeNull();
    expect(t.logs.create).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'login' }));
  });
});
