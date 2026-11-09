import { canLeave, canOwe, cleanMessage, isMember, matchReasons, phoneKey } from './membership.rules';

describe('cliente que pertence à loja (membership.rules)', () => {
  const sid = 'abc';

  it('cadastro só do lojista (sem conta online) pode ter fiado e não é membro', () => {
    expect(canOwe({ shopperId: null })).toBe(true);
    expect(isMember({ shopperId: null })).toBe(false);
  });

  it('conta online criada por compra, sem pedir para ser cliente: sem fiado', () => {
    expect(isMember({ shopperId: sid, origin: 'online', memberSince: null })).toBe(false);
    expect(canOwe({ shopperId: sid, origin: 'online', memberSince: null })).toBe(false);
  });

  it('quem aceitou (pedido ou convite) é membro e pode ter fiado', () => {
    const c = { shopperId: sid, origin: 'online' as const, memberSince: new Date() };
    expect(isMember(c)).toBe(true);
    expect(canOwe(c)).toBe(true);
  });

  it('vínculo antigo do balcão continua valendo', () => {
    expect(isMember({ shopperId: sid, origin: 'pos', memberSince: null })).toBe(true);
  });

  it('só sai com o saldo quitado', () => {
    expect(canLeave({ debitCents: 0 })).toBe(true);
    expect(canLeave({ debitCents: 1 })).toBe(false);
  });

  it('telefone comparável com ou sem +55, DDD e nono dígito', () => {
    expect(phoneKey('+55 (81) 99876-5432')).toBe(phoneKey('81 9876-5432'));
    expect(phoneKey('123')).toBe('');
  });

  it('sugere união por e-mail, telefone e nome', () => {
    const p = { email: 'ana@x.com', phone: '(81) 99876-5432', name: 'Ana Souza' };
    expect(matchReasons({ email: 'ANA@x.com' }, p)).toEqual({ score: 60, reasons: ['email'] });
    expect(matchReasons({ numberWithPrefix: '8198765432', name: 'Âna  Souza' }, p)).toEqual({ score: 40, reasons: ['phone', 'name'] });
    expect(matchReasons({ name: 'Bruno Lima' }, p).score).toBe(0);
  });

  it('recado curto e limpo', () => {
    expect(cleanMessage('oi\u0007 sou a Ana')).toBe('oi  sou a Ana');
    expect(cleanMessage('x'.repeat(300))).toHaveLength(200);
    expect(cleanMessage(5)).toBe('');
  });
});
