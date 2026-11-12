import { DomainError, domainHosts, domainToken, hostKey, normalizeDomain, pointsToUs } from './domain.rules';

describe('domínio próprio da loja', () => {
  const blocked = ['usebalcao.com', 'balcao.app'];
  it('normaliza o que o lojista digita', () => {
    expect(normalizeDomain('https://WWW.MinhaLoja.com.br/produtos?x=1', blocked)).toBe('minhaloja.com.br');
    expect(normalizeDomain('loja.minhamarca.com.br.', blocked)).toBe('loja.minhamarca.com.br');
    expect(normalizeDomain('xn--lojadoo-9za.com.br', blocked)).toBe('xn--lojadoo-9za.com.br');
    expect(domainHosts('minhaloja.com.br')).toEqual(['minhaloja.com.br', 'www.minhaloja.com.br']);
    expect(hostKey('WWW.MinhaLoja.com.br:443')).toBe('minhaloja.com.br');
  });

  it('recusa domínio da plataforma, IP, endereço interno e formato inválido', () => {
    for (const bad of ['', 'usebalcao.com', 'loja.usebalcao.com', 'balcao.app', '192.168.0.1', '[::1]', 'localhost', 'loja.local', 'minhaloja', 'minha_loja.com', 'lojão.com.br', '-loja.com', 'loja.c']) {
      expect(() => normalizeDomain(bad, blocked)).toThrow(DomainError);
    }
  });

  it('código do TXT é estável por loja e domínio, e muda se mudar qualquer um', () => {
    const a = domainToken('s', 'loja1', 'minhaloja.com.br');
    expect(a).toMatch(/^balcao-verificacao=[a-f0-9]{32}$/);
    expect(domainToken('s', 'loja1', 'minhaloja.com.br')).toBe(a);
    expect(domainToken('s', 'loja2', 'minhaloja.com.br')).not.toBe(a);
    expect(domainToken('s', 'loja1', 'outra.com.br')).not.toBe(a);
  });

  it('confere se o DNS aponta para o Balcão (IP ou nome)', () => {
    const target = { ips: ['203.0.113.10'], host: 'lojas.usebalcao.com' };
    expect(pointsToUs({ a: ['203.0.113.10'], cname: [] }, target)).toBe(true);
    expect(pointsToUs({ a: [], cname: ['lojas.usebalcao.com.'] }, target)).toBe(true);
    expect(pointsToUs({ a: ['198.51.100.7'], cname: ['outro.com'] }, target)).toBe(false);
  });
});
