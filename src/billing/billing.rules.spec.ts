import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Types } from 'mongoose';
import { calcFeeCents, DEBT_CAP_CENTS, graceDays } from './billing.constants';
import { dueDateFrom, feeWaived, inTrial, trialDaysLeft, trialEnd } from './billing.rules';
import { BillingService } from './billing.service';
import { periodOf } from '../common/period';
import { toCents } from '../common/money';
import { BillingGuard } from '../common/guards/billing.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';

const DAY = 24 * 3600_000;

describe('taxa de 0,5%', () => {
  it('calcula em centavos, meio-centavo para cima', () => {
    expect(calcFeeCents(10_000)).toBe(50);
    expect(calcFeeCents(100)).toBe(1);
    expect(calcFeeCents(99)).toBe(0);
    expect(calcFeeCents(250)).toBe(1);
    expect(calcFeeCents(800_000)).toBe(DEBT_CAP_CENTS);
  });
  it('converte reais em centavos sem erro de float', () => {
    expect(toCents(19.9)).toBe(1990);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
});

describe('período de cobrança (America/Fortaleza)', () => {
  it('usa o fuso de Fortaleza na virada do mês', () => {
    expect(periodOf(new Date('2026-11-01T02:59:00Z'))).toBe('2026-10');
    expect(periodOf(new Date('2026-11-01T03:00:00Z'))).toBe('2026-11');
  });
});

describe('teste grátis de 30 dias', () => {
  const created = new Date('2026-10-01T12:00:00Z');
  it('termina 30 dias após o cadastro quando não há data gravada (contas antigas)', () => {
    expect(trialEnd({ createdAt: created }).getTime()).toBe(created.getTime() + 30 * DAY);
  });
  it('usa trialEndsAt quando existe (admin pode estender)', () => {
    const ends = new Date('2027-01-01T00:00:00Z');
    expect(trialEnd({ createdAt: created, trialEndsAt: ends })).toEqual(ends);
  });
  it('dia 29 ainda é grátis, dia 31 já cobra', () => {
    expect(inTrial({ createdAt: created }, new Date(created.getTime() + 29 * DAY))).toBe(true);
    expect(inTrial({ createdAt: created }, new Date(created.getTime() + 30 * DAY))).toBe(false);
    expect(inTrial({ createdAt: created }, new Date(created.getTime() + 31 * DAY))).toBe(false);
  });
  it('conta os dias que faltam', () => {
    expect(trialDaysLeft({ createdAt: created }, new Date(created.getTime() + 10 * DAY))).toBe(20);
    expect(trialDaysLeft({ createdAt: created }, new Date(created.getTime() + 99 * DAY))).toBe(0);
  });
  it('quem não paga taxa: admin, isenta e em teste', () => {
    const now = new Date(created.getTime() + 45 * DAY);
    expect(feeWaived({ createdAt: created }, now)).toBeNull();
    expect(feeWaived({ createdAt: created, role: 'admin' }, now)).toBe('admin');
    expect(feeWaived({ createdAt: created, feeExempt: true }, now)).toBe('exempt');
    expect(feeWaived({ createdAt: created }, new Date(created.getTime() + 5 * DAY))).toBe('trial');
  });
});

describe('prazo de 15 dias', () => {
  it('padrão 15, configurável dentro de limites', () => {
    expect(graceDays(undefined)).toBe(15);
    expect(graceDays('20')).toBe(20);
    expect(graceDays('0')).toBe(15);
    expect(graceDays('9999')).toBe(15);
    expect(graceDays('abc')).toBe(15);
  });
  it('vencimento = emissão + dias', () => {
    const now = new Date('2026-11-01T03:05:00Z');
    expect(dueDateFrom(now, 15).toISOString()).toBe('2026-11-16T03:05:00.000Z');
  });
});

describe('BillingService.applyFee', () => {
  const sid = new Types.ObjectId();
  const EID = new Types.ObjectId().toHexString();
  const policy = { capCents: 4000 };
  const mk = (enterprise: Record<string, unknown>, monthSum = 0) => {
    const feeModel = {
      create: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockReturnValue({ session: jest.fn().mockResolvedValue(monthSum ? [{ sum: monthSum }] : []) }),
    };
    const enterpriseService = { lockForBilling: jest.fn().mockResolvedValue({ billing: { status: 'active' }, createdAt: new Date(Date.now() - 90 * DAY), ...enterprise }), addDebt: jest.fn() };
    const svc = new BillingService(feeModel as any, {} as any, {} as any, {} as any, enterpriseService as any, {} as any, { get: () => undefined } as any, { policy: async () => ({ capCents: policy.capCents, trialDays: 30 }) } as any);
    return { svc, feeModel, enterpriseService };
  };

  it('no teste grátis não cobra nada e não grava razão', async () => {
    const { svc, feeModel, enterpriseService } = mk({ createdAt: new Date(Date.now() - 5 * DAY) });
    await expect(svc.applyFee(EID, sid, 100_000, {} as any)).resolves.toBe(0);
    expect(feeModel.create).not.toHaveBeenCalled();
    expect(enterpriseService.addDebt).not.toHaveBeenCalled();
  });
  it('empresa isenta e admin não pagam', async () => {
    for (const e of [{ feeExempt: true }, { role: 'admin' }]) {
      const { svc, feeModel } = mk(e);
      await expect(svc.applyFee(EID, sid, 100_000, {} as any)).resolves.toBe(0);
      expect(feeModel.create).not.toHaveBeenCalled();
    }
  });
  it('depois do teste cobra 0,5% e soma à dívida', async () => {
    const { svc, feeModel, enterpriseService } = mk({});
    await expect(svc.applyFee(EID, sid, 10_000, {} as any)).resolves.toBe(50);
    expect(enterpriseService.addDebt).toHaveBeenCalledWith(EID, 50, expect.anything());
    expect(feeModel.create.mock.calls[0][0][0]).toMatchObject({ feeCents: 50, baseCents: 10_000 });
  });
  it('venda que cruza o teto do mês cobra só o que falta; no teto passa sem taxa', async () => {
    const a = mk({}, 3990);
    await expect(a.svc.applyFee(EID, sid, 1_000_000, {} as any)).resolves.toBe(10);
    const b = mk({}, 4000);
    await expect(b.svc.applyFee(EID, sid, 1_000_000, {} as any)).resolves.toBe(0);
    expect(b.feeModel.create).not.toHaveBeenCalled();
  });
  it('teto da empresa (definido pelo admin) vale mais que o padrão', async () => {
    const a = mk({ feeCapCents: 1000 }, 990);
    await expect(a.svc.applyFee(EID, sid, 1_000_000, {} as any)).resolves.toBe(10);
    const b = mk({ feeCapCents: 0 });
    await expect(b.svc.applyFee(EID, sid, 1_000_000, {} as any)).resolves.toBe(0);
    const c = mk({ feeCapCents: 10_000 }, 4000); // acima do padrão de R$ 40: ainda cobra
    await expect(c.svc.applyFee(EID, sid, 1_000_000, {} as any)).resolves.toBe(5000);
  });
  it('mudar o teto padrão da plataforma vale na hora', async () => {
    policy.capCents = 100;
    const a = mk({}, 90);
    await expect(a.svc.applyFee(EID, sid, 1_000_000, {} as any)).resolves.toBe(10);
    policy.capCents = 4000;
  });
  it('conta bloqueada: 402 BILLING_BLOCKED', async () => {
    const { svc } = mk({ billing: { status: 'blocked' } });
    await expect(svc.applyFee(EID, sid, 10_000, {} as any)).rejects.toMatchObject({ status: 402, response: { code: 'BILLING_BLOCKED' } });
  });
});

describe('guards', () => {
  class Ctl {
    plain() {}
    @Public() pub() {}
    @AllowWhenBlocked() allowed() {}
    @Roles('admin') adminOnly() {}
  }
  const ctx = (handler: Function, user?: unknown) =>
    ({ getHandler: () => handler, getClass: () => Ctl, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;
  const blockedUser = { billing: { status: 'blocked' } };

  it('BillingGuard bloqueia conta bloqueada, exceto @Public, @AllowWhenBlocked e admin', () => {
    const g = new BillingGuard(new Reflector());
    expect(() => g.canActivate(ctx(Ctl.prototype.plain, blockedUser))).toThrow(HttpException);
    expect(g.canActivate(ctx(Ctl.prototype.allowed, blockedUser))).toBe(true);
    expect(g.canActivate(ctx(Ctl.prototype.pub, blockedUser))).toBe(true);
    expect(g.canActivate(ctx(Ctl.prototype.plain, { billing: { status: 'active' } }))).toBe(true);
    expect(g.canActivate(ctx(Ctl.prototype.plain, { role: 'admin', ...blockedUser }))).toBe(true);
  });
  it('RolesGuard: rota de admin só para admin; sem decorator todo mundo passa', () => {
    const g = new RolesGuard(new Reflector());
    expect(() => g.canActivate(ctx(Ctl.prototype.adminOnly, { role: 'user' }))).toThrow();
    expect(() => g.canActivate(ctx(Ctl.prototype.adminOnly, {}))).toThrow();
    expect(() => g.canActivate(ctx(Ctl.prototype.adminOnly, undefined))).toThrow();
    expect(g.canActivate(ctx(Ctl.prototype.adminOnly, { role: 'admin' }))).toBe(true);
    expect(g.canActivate(ctx(Ctl.prototype.plain, { role: 'user' }))).toBe(true);
  });
  it('JwtAuthGuard respeita @Public()', () => {
    expect(new JwtAuthGuard(new Reflector()).canActivate(ctx(Ctl.prototype.pub))).toBe(true);
  });
});

import { freeMonthProblem, isFreeMonth } from './billing.rules';
describe('mês grátis (admin)', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  it('aceita AAAA-MM até 12 meses à frente e até 24 para trás', () => {
    expect(freeMonthProblem('2026-12', now)).toBeNull();
    expect(freeMonthProblem('2027-11', now)).toBeNull();
    expect(freeMonthProblem('2027-12', now)).toMatch(/12 meses/);
    expect(freeMonthProblem('2024-10', now)).toMatch(/antigo/);
    expect(freeMonthProblem('2026-13', now)).toMatch(/inválido/);
    expect(freeMonthProblem('nov/26', now)).toMatch(/inválido/);
  });
  it('só o mês escolhido fica sem taxa', () => {
    expect(isFreeMonth({ freeMonths: ['2026-11'] }, '2026-11')).toBe(true);
    expect(isFreeMonth({ freeMonths: ['2026-11'] }, '2026-12')).toBe(false);
    expect(isFreeMonth({}, '2026-11')).toBe(false);
  });
});
