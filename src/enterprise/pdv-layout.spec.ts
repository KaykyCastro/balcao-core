import { sanitizePdvLayout } from './pdv-layout.rules';

describe('sanitizePdvLayout (layout da tela de vendas compartilhado)', () => {
  it('guarda os campos válidos', () => {
    const r = sanitizePdvLayout({ template: 'noite', bg: '#111827', shape: 'pill', products: 'list', columns: 3, accent: '#2F6BFF', discountPresets: [10, 5, 5, 99], receipt: { paper: 'a4', footer: 'Volte sempre' } });
    expect(r).toEqual({ template: 'noite', bg: '#111827', shape: 'pill', products: 'list', columns: 3, accent: '#2F6BFF', discountPresets: [5, 10], receipt: { paper: 'a4', footer: 'Volte sempre' } });
  });

  it('descarta campo desconhecido e valor inválido', () => {
    const r = sanitizePdvLayout({ bg: 'red', shape: 'circle', columns: 7, hacker: true, popularLimit: 1000, receipt: { cols: 50, extra: 1, copies: 9 } });
    expect(r).toEqual({ receipt: {} });
  });

  it('ajustes da impressora ficam no aparelho (não vão para a conta)', () => {
    expect(sanitizePdvLayout({ receipt: { cols: 42, encoding: 'latin1', copies: 2, cut: false, feed: 4, autoPrint: true } })).toEqual({ receipt: {} });
  });

  it('accent null volta para a cor do painel', () => {
    expect(sanitizePdvLayout({ accent: null })).toEqual({ accent: null });
  });

  it('logo: data URL de imagem, https ou nada', () => {
    expect(sanitizePdvLayout({ logo: 'data:image/png;base64,AAAA' }).logo).toBe('data:image/png;base64,AAAA');
    expect(sanitizePdvLayout({ logo: 'https://cdn.exemplo.com/l.png' }).logo).toBe('https://cdn.exemplo.com/l.png');
    expect(sanitizePdvLayout({ logo: '' }).logo).toBeNull();
    expect('logo' in sanitizePdvLayout({ logo: 'javascript:alert(1)' })).toBe(false);
    expect('logo' in sanitizePdvLayout({ logo: 'data:image/svg+xml;base64,AAAA' })).toBe(false);
  });

  it('textos são cortados e sem caracteres de controle', () => {
    const r = sanitizePdvLayout({ subtitle: 'x'.repeat(90), receipt: { header: 'a\u0007b\n2\n3\n4\n5', footer: 'z'.repeat(200) } });
    expect(r.subtitle).toHaveLength(40);
    expect((r.receipt as any).header).toBe('ab\n2\n3\n4');
    expect((r.receipt as any).footer).toHaveLength(80);
  });

  it('não aceita nada que não seja objeto', () => {
    expect(sanitizePdvLayout('x')).toEqual({});
    expect(sanitizePdvLayout([1])).toEqual({});
  });
});

describe('layout da tela de vendas: acesso do colaborador', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { staffAccess } = require('../staff/staff.rules') as typeof import('../staff/staff.rules');
  const path = '/enterprise/0123456789abcdef01234567/pdv-layout';
  it('colaborador lê o layout do dono', () => expect(staffAccess('GET', path, ['sales']).ok).toBe(true));
  it('colaborador não muda o layout', () => expect(staffAccess('PUT', path, ['sales', 'stock', 'reports']).ok).toBe(false));
});
