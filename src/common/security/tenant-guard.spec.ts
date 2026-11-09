import { Schema, Types } from 'mongoose';
import { check, crossTenant, scopedFilter, tenantGuard, TenantScopeError } from './tenant-guard.plugin';

const eid = new Types.ObjectId();

describe('isolamento entre lojas (o "RLS" do MongoDB)', () => {
  it('filtro por loja passa; sem loja, não', () => {
    expect(scopedFilter({ enterpriseId: eid, status: 'pending' })).toBe(true);
    expect(scopedFilter({ $and: [{ enterpriseId: eid }, { x: 1 }] })).toBe(true);
    expect(scopedFilter({ _id: new Types.ObjectId() })).toBe(false); // só o id não prova de qual loja é
    expect(scopedFilter({ enterpriseId: { $exists: true } })).toBe(false);
    expect(scopedFilter({ enterpriseId: { $ne: eid } })).toBe(false);
    expect(scopedFilter(undefined)).toBe(false);
  });

  it('modo strict recusa consulta sem loja; warn só registra; exceção declarada passa', () => {
    expect(() => check('Sale', 'find', { status: 'completed' }, {}, 'strict')).toThrow(TenantScopeError);
    expect(() => check('Sale', 'find', { status: 'completed' }, {}, 'warn')).not.toThrow();
    expect(() => check('Sale', 'find', { enterpriseId: eid }, {}, 'strict')).not.toThrow();
    expect(() => check('Sale', 'find', {}, {}, 'strict', undefined, 'admin: totais')).not.toThrow();
    expect(() => check('Sale', 'find', {}, {}, 'off')).not.toThrow();
  });

  it('crossTenant exige motivo e marca só as consultas do model envolvido', () => {
    const q = { tag: 'consulta' };
    const model = { find: jest.fn(() => q), modelName: 'Sale' };
    expect(() => crossTenant(model, ' ')).toThrow();
    const wrapped = crossTenant(model, 'admin: totais');
    expect(wrapped.find()).toBe(q);
    expect(Object.getOwnPropertySymbols(q).length).toBe(1);
    expect(wrapped.modelName).toBe('Sale');
  });

  it('o plugin só entra em coleções que têm enterpriseId', () => {
    const withTenant = new Schema({ enterpriseId: Types.ObjectId, name: String });
    const global = new Schema({ name: String });
    const pre = jest.spyOn(withTenant, 'pre'); const preG = jest.spyOn(global, 'pre');
    tenantGuard(withTenant); tenantGuard(global);
    expect(pre).toHaveBeenCalledWith('find', expect.any(Function));
    expect(pre).toHaveBeenCalledWith('aggregate', expect.any(Function));
    expect(preG).not.toHaveBeenCalled();
  });
});
