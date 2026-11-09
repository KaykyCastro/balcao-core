import { Types } from 'mongoose';
import { AdminTrustService } from './admin-trust.service';
import { LEGAL_VERSIONS } from '../common/legal-versions';

const actor = { id: new Types.ObjectId().toHexString(), email: 'adm@x.com' };
const eid = new Types.ObjectId();
const sid = new Types.ObjectId();

function setup(store: any = null, opts: { shopper?: any; outdated?: any[] } = {}) {
  const stores: any = { findById: jest.fn(async () => store), updateOne: jest.fn(async () => ({})) };
  const shoppers: any = { findById: jest.fn(() => ({ select: () => ({ lean: async () => opts.shopper ?? null }) })) };
  const enterprises: any = { find: jest.fn(() => ({ select: () => ({ lean: async () => opts.outdated ?? [] }) })) };
  const audit: any = { create: jest.fn(async () => ({})) };
  const shopperService: any = { erase: jest.fn(async () => true) };
  const messages: any = { sendTo: jest.fn(async (_a: unknown, ids: unknown[]) => ({ broadcastId: 'b', recipients: ids.length })) };
  const svc = new AdminTrustService(stores, {} as any, shoppers, enterprises, {} as any, audit, shopperService, messages, {} as any);
  jest.spyOn(svc, 'getStore').mockResolvedValue({ id: String(sid) } as any);
  return { svc, stores, audit, shopperService, messages, enterprises };
}

describe('admin: suspender loja online', () => {
  const doc = (o: object = {}) => ({ _id: sid, enterpriseId: eid, slug: 'bella', name: 'Bella', enabled: true, adminBlock: null, ...o });

  it('tira do ar, guarda o motivo, registra na auditoria e avisa o lojista', async () => {
    const t = setup(doc());
    await t.svc.blockStore(actor, String(sid), 'Denúncia de produto falsificado');
    const set = t.stores.updateOne.mock.calls[0][1].$set;
    expect(set.enabled).toBe(false);
    expect(set.adminBlock).toMatchObject({ at: expect.any(Date), reason: 'Denúncia de produto falsificado', by: 'adm@x.com' });
    expect(t.audit.create.mock.calls[0][0]).toMatchObject({ action: 'store.block', actorEmail: 'adm@x.com', meta: { slug: 'bella', wasOnline: true } });
    expect(String(t.audit.create.mock.calls[0][0].targetEnterpriseId)).toBe(String(eid));
    expect(t.messages.sendTo).toHaveBeenCalledWith(actor, [eid], expect.objectContaining({ level: 'warning', body: expect.stringContaining('produto falsificado') }));
  });

  it('sem aviso quando o admin pede; não suspende duas vezes', async () => {
    const t = setup(doc());
    await t.svc.blockStore(actor, String(sid), 'Dados do vendedor falsos', false);
    expect(t.messages.sendTo).not.toHaveBeenCalled();
    const t2 = setup(doc({ adminBlock: { at: new Date(), reason: 'x', by: 'a' } }));
    await expect(t2.svc.blockStore(actor, String(sid), 'de novo, outra vez')).rejects.toMatchObject({ status: 400 });
  });

  it('liberar tira a suspensão mas não religa a loja sozinha', async () => {
    const t = setup(doc({ enabled: false, adminBlock: { at: new Date(), reason: 'Denúncia', by: 'a' } }));
    await t.svc.unblockStore(actor, String(sid), 'Lojista enviou as notas');
    const set = t.stores.updateOne.mock.calls[0][1].$set;
    expect(set).toEqual({ adminBlock: { at: null, reason: '', by: '' } });
    expect(t.audit.create.mock.calls[0][0]).toMatchObject({ action: 'store.unblock', meta: { previousReason: 'Denúncia', note: 'Lojista enviou as notas' } });
    expect(t.messages.sendTo).toHaveBeenCalledTimes(1);
  });

  it('loja inexistente: 404', async () => {
    await expect(setup(null).svc.blockStore(actor, String(sid), 'motivo qualquer')).rejects.toMatchObject({ status: 404 });
  });
});

describe('admin: LGPD', () => {
  it('excluir comprador a pedido do titular: apaga, e a auditoria guarda o motivo sem o e-mail completo', async () => {
    const shopper = { _id: new Types.ObjectId(), email: 'ana.souza@ex.com' };
    const t = setup(null, { shopper });
    await expect(t.svc.deleteShopper(actor, String(shopper._id), 'E-mail do titular em 02/11')).resolves.toEqual({ deleted: true });
    expect(t.shopperService.erase).toHaveBeenCalledWith(shopper._id);
    expect(t.audit.create.mock.calls[0][0]).toMatchObject({ action: 'shopper.delete', meta: { email: 'an***@ex.com', reason: 'E-mail do titular em 02/11', by: 'admin' } });
    expect(JSON.stringify(t.audit.create.mock.calls[0][0])).not.toContain('ana.souza');
  });

  it('comprador inexistente: 404 e nada é apagado', async () => {
    const t = setup(null);
    await expect(t.svc.deleteShopper(actor, String(new Types.ObjectId()), 'pedido por e-mail')).rejects.toMatchObject({ status: 404 });
    expect(t.shopperService.erase).not.toHaveBeenCalled();
  });

  it('lembrete aos lojistas na versão antiga: um envio só, registrado', async () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    const t = setup(null, { outdated: ids.map((_id) => ({ _id })) });
    await expect(t.svc.remindOutdated(actor)).resolves.toMatchObject({ recipients: 2 });
    expect(t.messages.sendTo).toHaveBeenCalledWith(actor, ids, expect.objectContaining({ title: expect.stringContaining('Termos') }));
    const q = t.enterprises.find.mock.calls[0][0];
    expect(JSON.stringify(q)).toContain(LEGAL_VERSIONS.terms);
    expect(t.audit.create.mock.calls[0][0]).toMatchObject({ action: 'compliance.remind', meta: { recipients: 2 } });
  });

  it('lembrete sem ninguém desatualizado: 400', async () => {
    await expect(setup(null, { outdated: [] }).svc.remindOutdated(actor)).rejects.toMatchObject({ status: 400 });
  });
});
