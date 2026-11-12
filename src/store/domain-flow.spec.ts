import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';

const dnsState = { a: [] as string[], txt: [] as string[][] };
jest.mock('dns', () => ({ promises: {
  resolve4: jest.fn(async () => { if (!dnsState.a.length) throw new Error('ENODATA'); return dnsState.a; }),
  resolve6: jest.fn(async () => { throw new Error('ENODATA'); }),
  resolveCname: jest.fn(async () => { throw new Error('ENODATA'); }),
  resolveTxt: jest.fn(async () => { if (!dnsState.txt.length) throw new Error('ENOTFOUND'); return dnsState.txt; }),
} }));

import { DomainService } from './domain.service';
import { domainToken } from './domain.rules';

function setup() {
  const eid = new Types.ObjectId();
  const store: any = { _id: new Types.ObjectId(), enterpriseId: eid, slug: 'pele-boa', domain: null };
  const others: any[] = [];
  const match = (doc: any, q: any) => (!q['domain.host'] || doc.domain?.host === q['domain.host']) && (!q['domain.status'] || doc.domain?.status === q['domain.status']) && (!q._id?.$ne || String(doc._id) !== String(q._id.$ne));
  const model: any = {
    findOne: jest.fn((q: any) => {
      const r = q.enterpriseId ? store : [store, ...others].find((d) => match(d, q)) ?? null;
      return Object.assign(Promise.resolve(r), { select: () => ({ lean: async () => r }) });
    }),
    exists: jest.fn(async (q: any) => [store, ...others].some((d) => match(d, q))),
    updateOne: jest.fn(async (_q: any, u: any) => {
      for (const [k, v] of Object.entries(u.$set)) {
        if (k === 'domain') store.domain = v; else { const [, f] = k.split('.'); store.domain = { ...store.domain, [f]: v }; }
      }
    }),
  };
  const config = new ConfigService({ DOMAIN_TARGET_IPS: '203.0.113.10', DOMAIN_TARGET_HOST: 'lojas.usebalcao.com', FRONTEND_URL: 'https://usebalcao.com', APP_URL: 'https://api.usebalcao.com', JWT_SECRET: 'segredo' });
  return { svc: new DomainService(model, config), store, others, eid: String(eid) };
}

describe('domínio próprio: cadastro, verificação e liberação', () => {
  beforeEach(() => { dnsState.a = []; dnsState.txt = []; });

  it('cadastra, mostra os registros, e só ativa com o DNS apontando e o TXT certo', async () => {
    const t = setup();
    await expect(t.svc.set(t.eid, 'loja.usebalcao.com')).rejects.toMatchObject({ status: 422 }); // domínio da plataforma
    const info = await t.svc.set(t.eid, 'https://www.MinhaLoja.com.br/');
    expect(info).toMatchObject({ host: 'minhaloja.com.br', status: 'pending' });
    const txt = domainToken('segredo', String(t.store._id), 'minhaloja.com.br');
    expect(info.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'A', name: '@', value: '203.0.113.10' }),
      expect.objectContaining({ type: 'CNAME', name: 'www', value: 'lojas.usebalcao.com' }),
      expect.objectContaining({ type: 'TXT', name: '_balcao', value: txt }),
    ]));

    // só o A: continua pendente, com o que falta
    dnsState.a = ['203.0.113.10'];
    let v = await t.svc.verify(t.eid);
    expect(v.status).toBe('pending');
    expect(v.error).toMatch(/TXT/);
    expect(await t.svc.allow('minhaloja.com.br')).toBe(false);

    // A + TXT: ativo, o Caddy pode emitir o certificado (com e sem www) e a vitrine acha a loja
    dnsState.txt = [[txt]];
    v = await t.svc.verify(t.eid);
    expect(v).toMatchObject({ status: 'active', error: '' });
    expect(await t.svc.allow('www.minhaloja.com.br')).toBe(true);
    expect(await t.svc.allow('outro.com.br')).toBe(false);
    expect(await t.svc.byHost('WWW.minhaloja.com.br')).toEqual({ slug: 'pele-boa', host: 'minhaloja.com.br' });
  });

  it('domínio já ativo em outra loja não pode ser cadastrado; remover desliga', async () => {
    const t = setup();
    t.others.push({ _id: new Types.ObjectId(), domain: { host: 'ocupado.com.br', status: 'active' } });
    await expect(t.svc.set(t.eid, 'ocupado.com.br')).rejects.toMatchObject({ status: 409 });
    await t.svc.set(t.eid, 'livre.com.br');
    expect((await t.svc.remove(t.eid)).host).toBeNull();
  });
});
