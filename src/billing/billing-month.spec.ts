import { Types } from 'mongoose';
import { BillingService } from './billing.service';
import { nextMonthStart, periodOf } from '../common/period';

const DAY = 24 * 3600_000;
const EID = new Types.ObjectId().toHexString();

describe('virada do mês (Fortaleza)', () => {
  it('o mês seguinte começa às 03:00 UTC', () => {
    expect(nextMonthStart(new Date('2026-10-22T12:00:00Z')).toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(nextMonthStart(new Date('2026-12-31T20:00:00Z')).toISOString()).toBe('2027-01-01T03:00:00.000Z');
    expect(nextMonthStart(new Date('2026-11-01T02:59:00Z')).toISOString()).toBe('2026-11-01T03:00:00.000Z'); // ainda é outubro lá
  });
});

describe('BillingService: taxa mensal, sem acúmulo e sem pagar adiantado', () => {
  const mk = (o: { monthFee?: number; online?: number; unbilled?: number; enterprise?: object; pending?: any[]; cap?: number } = {}) => {
    const feeModel: any = {
      aggregate: jest.fn((pipeline: any[]) => {
        const isMonth = !!pipeline[0].$match.period;
        const online = pipeline[0].$match.channel === 'online'; // taxa da loja online (fora do teto)
        const sum = online ? o.online ?? 0 : isMonth ? o.monthFee ?? 0 : o.unbilled ?? 0;
        const res = sum ? [{ sum }] : [];
        return Object.assign(Promise.resolve(res), { session: () => Promise.resolve(res) });
      }),
    };
    const invoiceModel: any = {
      find: jest.fn().mockReturnValue({ sort: () => Promise.resolve(o.pending ?? []) }),
      findOne: jest.fn().mockReturnValue({ sort: () => Promise.resolve((o.pending ?? [])[0] ?? null) }),
    };
    const ents = { findEnterpriseById: jest.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 90 * DAY), billing: { status: 'active' }, debtCents: 0, ...o.enterprise }) };
    const settings = { policy: async () => ({ capCents: o.cap ?? 4000, trialDays: 30 }) };
    const svc = new BillingService(feeModel, invoiceModel, {} as any, {} as any, ents as any, {} as any, { get: () => undefined } as any, settings as any);
    return { svc, feeModel, invoiceModel };
  };

  it('resumo separa a taxa do mês atual (acumulando) das faturas já emitidas', async () => {
    const inv = { _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId(), amountCents: 4000, status: 'pending', dueDate: new Date(Date.now() + 5 * DAY) };
    const s = await mk({ monthFee: 1500, unbilled: 1500, pending: [inv] }).svc.getSummary(EID);
    expect(s.currentMonth).toMatchObject({ period: periodOf(), feeCents: 1500, capCents: 4000, capReached: false, unbilledCents: 1500, canPayEarly: false });
    expect(s.currentMonth.closesAt.getTime()).toBeGreaterThan(Date.now());
    expect(s.pendingCents).toBe(4000);
    expect(s.remainingCents).toBe(2500);
  });
  it('a taxa do mês atual aparece mesmo com a fatura do mês passado ainda pendente', async () => {
    const inv = { _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId(), amountCents: 4000, status: 'pending', dueDate: new Date(Date.now() + 5 * DAY) };
    const s = await mk({ monthFee: 700, unbilled: 700, pending: [inv] }).svc.getSummary(EID);
    expect(s.pendingCents).toBe(4000);
    expect(s.currentMonth.feeCents).toBe(700);
    expect(s.accountBlocked).toBe(false); // taxa corrente nunca bloqueia; só fatura vencida
  });
  it('comissão da loja online (já recebida pelo Mercado Pago) só aparece como informação: fora do teto e da fatura', async () => {
    const s = await mk({ monthFee: 1000, online: 1500, unbilled: 1000 }).svc.getSummary(EID);
    expect(s.currentMonth).toMatchObject({ feeCents: 1000, onlineFeeCents: 1500, capReached: false, canPayEarly: false });
    expect(s.remainingCents).toBe(3000);
  });
  it('só pode adiantar ao atingir o teto do mês', async () => {
    expect((await mk({ monthFee: 4000, unbilled: 4000 }).svc.getSummary(EID)).currentMonth.canPayEarly).toBe(true);
    expect((await mk({ monthFee: 3999, unbilled: 3999 }).svc.getSummary(EID)).currentMonth.canPayEarly).toBe(false);
    expect((await mk({ monthFee: 4000, unbilled: 0 }).svc.getSummary(EID)).currentMonth.canPayEarly).toBe(false); // já faturado
  });
  it('teto da empresa muda o limite de adiantar', async () => {
    expect((await mk({ monthFee: 1000, unbilled: 1000, enterprise: { feeCapCents: 1000 } }).svc.getSummary(EID)).currentMonth.canPayEarly).toBe(true);
  });
  it('fechar fatura antes do teto → 409', async () => {
    const { svc } = mk({ monthFee: 3000, unbilled: 3000 });
    await expect(svc.issueInvoiceNow(EID)).rejects.toMatchObject({ status: 409 });
  });
  it('teto 0 (sem taxa) nunca libera adiantar', async () => {
    await expect(mk({ monthFee: 0, unbilled: 0, cap: 0 }).svc.issueInvoiceNow(EID)).rejects.toMatchObject({ status: 409 });
  });
  it('no teto: emite a fatura (uma só chamada de emissão)', async () => {
    const { svc } = mk({ monthFee: 4000, unbilled: 4000 });
    const spy = jest.spyOn(svc, 'issueInvoice').mockResolvedValue({ _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId(), amountCents: 4000, status: 'pending', dueDate: new Date(), kind: 'on_demand', periodFrom: periodOf(), periodTo: periodOf() } as any);
    await expect(svc.issueInvoiceNow(EID)).resolves.toMatchObject({ amountCents: 4000, kind: 'on_demand' });
    expect(spy).toHaveBeenCalledWith(EID, expect.objectContaining({ kind: 'on_demand' }));
  });
});

describe('cancelar fatura (perdão)', () => {
  it('estorna as taxas da fatura para não contarem no teto do mês, abate a dívida e reavalia o bloqueio', async () => {
    const inv = { _id: new Types.ObjectId(), enterpriseId: new Types.ObjectId(), amountCents: 4000 };
    const feeModel: any = { updateMany: jest.fn().mockResolvedValue({}) };
    const invoiceModel: any = { findOneAndUpdate: jest.fn().mockResolvedValue(inv), exists: jest.fn().mockReturnValue({ session: () => Promise.resolve(null) }) };
    const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: jest.fn() };
    const ents = { addDebt: jest.fn(), setBlocked: jest.fn() };
    const svc = new BillingService(feeModel, invoiceModel, {} as any, { startSession: async () => session } as any, ents as any, {} as any, { get: () => undefined } as any, {} as any);
    await svc.adminCancelInvoice(String(inv._id));
    expect(feeModel.updateMany.mock.calls[0][0]).toEqual({ invoiceId: inv._id, reversedAt: null });
    expect(feeModel.updateMany.mock.calls[0][1].$set.reversedAt).toBeInstanceOf(Date);
    expect(ents.addDebt).toHaveBeenCalledWith(String(inv.enterpriseId), -4000, session);
    expect(ents.setBlocked).toHaveBeenCalledWith(String(inv.enterpriseId), false, session);
  });
});
