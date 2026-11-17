import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CashCloseService } from './cash-close.service';

const EID = new Types.ObjectId().toHexString();
const CUST = new Types.ObjectId();

function setup(passwordOk = true) {
  const q = (v: unknown) => ({ select() { return this; }, sort() { return this; }, lean: async () => v });
  const stored: any[] = [];
  const sales: any = { find: () => q([{ paymentMethod: 'cash', status: 'completed', totalCents: 10000, createdAt: new Date() }]) };
  const payments: any = { find: () => q([{ customerId: CUST, method: 'pix', amountCents: 2500, createdAt: new Date() }, { customerId: CUST, method: 'cash', amountCents: 1000, createdAt: new Date() }]) };
  const closings: any = { findOne: () => q(null) };
  const exchanges: any = { find: () => q([]) };
  const withdrawals: any = { find: () => q(stored), create: jest.fn(async (d: any) => { stored.push({ ...d, _id: new Types.ObjectId(), createdAt: new Date() }); return d; }) };
  const customers: any = { find: () => q([{ _id: CUST, name: 'Maria' }]) };
  const enterprises: any = { verifyOwnerPassword: jest.fn(async () => { if (!passwordOk) throw new ForbiddenException({ code: 'OWNER_PASSWORD_WRONG' }); }) };
  const svc = new CashCloseService(sales, payments, closings, exchanges, withdrawals, customers, enterprises);
  return { svc, withdrawals, enterprises, stored };
}

describe('fechamento: retirada de dinheiro e fiado recebido', () => {
  it('retira com motivo e senha do dono: fica registrada e sai do esperado na gaveta', async () => {
    const t = setup();
    const before = await t.svc.day(EID, undefined, null);
    const r = await t.svc.withdraw(EID, { amountCents: 3000, reason: '  Compra de sacolas  ', ownerPassword: 'segredo' }, { id: new Types.ObjectId().toHexString(), name: 'Joana', permissions: ['sales'] } as never);
    expect(t.enterprises.verifyOwnerPassword).toHaveBeenCalledWith(EID, 'segredo');
    expect(t.stored[0]).toMatchObject({ amountCents: 3000, reason: 'Compra de sacolas', by: { name: 'Joana' } });
    expect(r.summary.cash.withdrawnCents).toBe(3000);
    expect(r.summary.cash.expectedCents).toBe(before.summary.cash.expectedCents - 3000);
    expect(r.summary.withdrawals[0]).toMatchObject({ amountCents: 3000, reason: 'Compra de sacolas', by: 'Joana' });
  });

  it('senha errada: nada é registrado', async () => {
    const t = setup(false);
    await expect(t.svc.withdraw(EID, { amountCents: 3000, reason: 'Banco', ownerPassword: 'errada' }, null)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.withdrawals.create).not.toHaveBeenCalled();
  });

  it('sem motivo: recusa antes de conferir a senha', async () => {
    const t = setup();
    await expect(t.svc.withdraw(EID, { amountCents: 3000, reason: ' a ', ownerPassword: 'segredo' }, null)).rejects.toMatchObject({ response: { code: 'WITHDRAW_REASON' } });
    expect(t.enterprises.verifyOwnerPassword).not.toHaveBeenCalled();
  });

  it('lista os pagamentos de fiado do dia com o nome do cliente e separa por forma', async () => {
    const t = setup();
    const r = await t.svc.day(EID, undefined, null);
    expect(r.summary.fiadoPayments).toEqual([
      expect.objectContaining({ customerName: 'Maria', method: 'pix', amountCents: 2500 }),
      expect.objectContaining({ customerName: 'Maria', method: 'cash', amountCents: 1000 }),
    ]);
    expect(r.summary.drawer.find((d) => d.method === 'pix')).toMatchObject({ salesCents: 0, fiadoCents: 2500 });
    expect(r.summary.drawer.find((d) => d.method === 'cash')).toMatchObject({ salesCents: 10000, fiadoCents: 1000 });
  });
});
