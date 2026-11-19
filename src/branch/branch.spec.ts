import { BranchError, branchEmail, branchName, branchTrialEnd, importPlan, isBranchEmail, rootOf } from './branch.rules';

describe('filiais: regras', () => {
  it('nome da filial: limpa espaços e recusa vazio ou longo', () => {
    expect(branchName('  Loja   Centro ')).toBe('Loja Centro');
    expect(() => branchName('a')).toThrow(BranchError);
    expect(() => branchName('x'.repeat(61))).toThrow(BranchError);
  });

  it('e-mail interno da filial nunca é um e-mail real', () => {
    expect(isBranchEmail(branchEmail('abc'))).toBe(true);
    expect(isBranchEmail('dono@loja.com')).toBe(false);
  });

  it('matriz do grupo', () => {
    expect(rootOf({ _id: 'm1', parentId: null })).toBe('m1');
    expect(rootOf({ _id: 'f1', parentId: 'm1' })).toBe('m1');
  });

  it('importação: pula códigos que já existem (sem diferença de maiúsculas), não repete e cria só as categorias que faltam', () => {
    const r = importPlan([
      { _id: 1, code: 'V1', name: 'Vestido', categoryName: 'Vestidos' },
      { _id: 2, code: 'b1', name: 'Bolsa', categoryName: 'Acessórios' },
      { _id: 3, code: 'C1', name: 'Cinto', categoryName: 'acessórios' },
      { _id: 4, code: 'c1', name: 'Cinto repetido', categoryName: 'Acessórios' },
    ], ['B1'], ['VESTIDOS']);
    expect(r.take.map((p) => p.code)).toEqual(['V1', 'C1']);
    expect(r.skipped).toEqual([{ code: 'b1', name: 'Bolsa' }, { code: 'c1', name: 'Cinto repetido' }]);
    expect(r.newCategories).toEqual(['acessórios']);
  });

  it('filial nova herda o fim do teste grátis da matriz, nunca ganha outro', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    expect(branchTrialEnd(new Date('2026-12-01T00:00:00Z'), now)).toEqual(new Date('2026-12-01T00:00:00Z'));
    expect(branchTrialEnd(new Date('2026-10-01T00:00:00Z'), now)).toEqual(now);
    expect(branchTrialEnd(null, now)).toEqual(now);
  });
});
