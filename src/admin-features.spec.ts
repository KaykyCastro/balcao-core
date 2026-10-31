import { Types } from 'mongoose';
import { AdminService } from './admin/admin.service';
import { MessagesService } from './messages/messages.service';
import { SettingsService } from './settings/settings.service';

const DAY = 24 * 3600_000;
const EID = new Types.ObjectId().toHexString();

describe('SettingsService', () => {
  const mk = (doc: any) => {
    const model: any = { findOne: jest.fn().mockReturnValue({ lean: async () => doc }), updateOne: jest.fn().mockResolvedValue({}) };
    return { svc: new SettingsService(model), model };
  };
  it('sem documento: padrão R$ 40 e 30 dias', async () => {
    expect(await mk(null).svc.policy()).toEqual({ capCents: 4000, trialDays: 30, onlineRateBps: 150, directoryRateBps: 300 });
  });
  it('trialDays 0 é respeitado (não vira o padrão)', async () => {
    expect(await mk({ capCents: 0, trialDays: 0 }).svc.policy()).toMatchObject({ capCents: 0, trialDays: 0 });
  });
  it('usa cache curto e o update limpa o cache', async () => {
    const { svc, model } = mk({ capCents: 5000, trialDays: 10 });
    await svc.policy(); await svc.policy();
    expect(model.findOne).toHaveBeenCalledTimes(1);
    await svc.update({ capCents: 6000 }, 'adm@x.com');
    expect(model.updateOne.mock.calls[0][1].$set).toEqual({ updatedBy: 'adm@x.com', capCents: 6000 });
    expect(model.findOne).toHaveBeenCalledTimes(2);
  });
});

describe('AdminService.updateEnterprise (teste grátis e teto)', () => {
  const mk = (target: any) => {
    const ents: any = { findById: jest.fn().mockResolvedValue(target) };
    const es = { adminPatch: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(), name: 'n', email: 'e', status: 'active', billing: { status: 'active' }, createdAt: new Date() }) };
    const audit = { create: jest.fn().mockResolvedValue({}) };
    const svc = new AdminService(ents, {} as any, {} as any, {} as any, {} as any, {} as any, audit as any, es as any, {} as any, {} as any, {} as any);
    return { svc, es, audit };
  };
  const actor = { id: new Types.ObjectId().toHexString(), email: 'adm@x.com' };
  const ent = (o: object = {}) => ({ role: 'user', createdAt: new Date(Date.now() - 5 * DAY), trialEndsAt: new Date(Date.now() + 10 * DAY), ...o });
  const endsIn = (es: any) => (es.adminPatch.mock.calls[0][1].trialEndsAt.getTime() - Date.now()) / DAY;

  it('remover dias: tira do fim do teste', async () => {
    const { svc, es } = mk(ent());
    await svc.updateEnterprise(actor, EID, { removeTrialDays: 4 });
    expect(endsIn(es)).toBeCloseTo(6, 1);
  });
  it('remover mais dias do que sobram: o teste acaba agora, nunca no passado', async () => {
    const { svc, es } = mk(ent());
    await svc.updateEnterprise(actor, EID, { removeTrialDays: 100 });
    expect(Math.abs(endsIn(es))).toBeLessThan(0.01);
  });
  it('encerrar teste: acaba agora', async () => {
    const { svc, es } = mk(ent());
    await svc.updateEnterprise(actor, EID, { endTrial: true });
    expect(Math.abs(endsIn(es))).toBeLessThan(0.01);
  });
  it('somar dias parte de hoje se o teste já acabou', async () => {
    const { svc, es } = mk(ent({ trialEndsAt: new Date(Date.now() - 20 * DAY) }));
    await svc.updateEnterprise(actor, EID, { extendTrialDays: 7 });
    expect(endsIn(es)).toBeCloseTo(7, 1);
  });
  it('mais de uma ação sobre o teste na mesma chamada → 400', async () => {
    const { svc } = mk(ent());
    await expect(svc.updateEnterprise(actor, EID, { extendTrialDays: 3, removeTrialDays: 2 })).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateEnterprise(actor, EID, { endTrial: true, extendTrialDays: 2 })).rejects.toMatchObject({ status: 400 });
  });
  it('teto da empresa: define e volta ao padrão com null (0 também vale)', async () => {
    for (const v of [2500, 0, null]) {
      const { svc, es } = mk(ent());
      await svc.updateEnterprise(actor, EID, { feeCapCents: v });
      expect(es.adminPatch.mock.calls[0][1]).toEqual({ feeCapCents: v });
    }
  });
  it('sem nada para alterar → 400; conta admin não é alterada; tudo vai para a auditoria', async () => {
    await expect(mk(ent()).svc.updateEnterprise(actor, EID, {})).rejects.toMatchObject({ status: 400 });
    await expect(mk(ent({ role: 'admin' })).svc.updateEnterprise(actor, EID, { endTrial: true })).rejects.toMatchObject({ status: 403 });
    const { svc, audit } = mk(ent());
    await svc.updateEnterprise(actor, EID, { endTrial: true });
    expect(audit.create.mock.calls[0][0]).toMatchObject({ action: 'enterprise.update', actorEmail: 'adm@x.com' });
  });
});

describe('MessagesService', () => {
  const mk = (opts: { findOneAndUpdate?: any; findOne?: any; enterprise?: any; actives?: number } = {}) => {
    const model: any = {
      findOneAndUpdate: jest.fn().mockResolvedValue(opts.findOneAndUpdate ?? null),
      findOne: jest.fn().mockResolvedValue(opts.findOne ?? null),
      create: jest.fn().mockResolvedValue({}),
      insertMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 3 }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    };
    const n = opts.actives ?? 0;
    const ents: any = {
      findOne: jest.fn().mockReturnValue({ select: async () => opts.enterprise ?? null }),
      find: jest.fn().mockReturnValue({ select: () => ({ cursor: () => (async function* () { for (let i = 0; i < n; i++) yield { _id: new Types.ObjectId() }; })() }) }),
    };
    return { svc: new MessagesService(model, ents), model, ents };
  };
  const sender = { email: 'adm@x.com' };

  it('marcar como lida só atinge mensagem da própria empresa', async () => {
    const { svc, model } = mk({});
    await expect(svc.markRead(EID, new Types.ObjectId().toHexString())).rejects.toMatchObject({ status: 404 });
    expect(model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ enterpriseId: EID, readAt: null });
    expect(model.findOne.mock.calls[0][0]).toMatchObject({ enterpriseId: EID });
  });
  it('envio para uma empresa: cria 1 documento; empresa inexistente → 404', async () => {
    const ok = mk({ enterprise: { _id: new Types.ObjectId() } });
    expect(await ok.svc.send(sender, { enterpriseId: EID, title: 't', body: 'b' })).toMatchObject({ recipients: 1 });
    expect(ok.model.create.mock.calls[0][0]).toMatchObject({ title: 't', level: 'info', senderEmail: 'adm@x.com', readAt: null });
    expect(ok.ents.findOne.mock.calls[0][0]).toMatchObject({ role: 'user' }); // admin não recebe
    await expect(mk({}).svc.send(sender, { enterpriseId: EID, title: 't', body: 'b' })).rejects.toMatchObject({ status: 404 });
  });
  it('envio para todas: em lotes, todos com o mesmo broadcastId; sem empresas → 400', async () => {
    const { svc, model, ents } = mk({ actives: 1200 });
    const r = await svc.send(sender, { title: 't', body: 'b', level: 'warning' });
    expect(r.recipients).toBe(1200);
    expect(model.insertMany.mock.calls.map((c: any[]) => c[0].length)).toEqual([500, 500, 200]);
    const ids = new Set(model.insertMany.mock.calls.flatMap((c: any[]) => c[0].map((d: any) => String(d.broadcastId))));
    expect(ids.size).toBe(1);
    expect(ents.find.mock.calls[0][0]).toEqual({ role: 'user', status: 'active' });
    await expect(mk({ actives: 0 }).svc.send(sender, { title: 't', body: 'b' })).rejects.toMatchObject({ status: 400 });
  });
  it('recolher é idempotente e aceita id do envio ou da mensagem', async () => {
    const { svc, model } = mk();
    const id = new Types.ObjectId().toHexString();
    await expect(svc.recall(id)).resolves.toEqual({ removed: 0 }); // já recolhido: não é erro
    expect(model.deleteMany.mock.calls[0][0]).toEqual({ $or: [{ broadcastId: id }, { _id: id }] });
  });
});
