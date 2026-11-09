import { decrypt, encrypt, encryptUpdate, ENC_PREFIX, isEncrypted, mapPaths, phoneIndex } from './field-crypto';

describe('dados pessoais criptografados (field-crypto)', () => {
  it('cifra e decifra; nunca cifra duas vezes; vazio e não-texto ficam como estão', () => {
    const c = encrypt('123.456.789-09') as string;
    expect(c.startsWith(ENC_PREFIX)).toBe(true);
    expect(c).not.toContain('123.456');
    expect(encrypt(c)).toBe(c);
    expect(decrypt(c)).toBe('123.456.789-09');
    expect(encrypt('')).toBe('');
    expect(encrypt(null)).toBeNull();
    expect(decrypt('texto antigo em claro')).toBe('texto antigo em claro');
    expect(encrypt('a')).not.toBe(encrypt('a')); // IV aleatório: o mesmo valor não gera a mesma cifra
  });

  it('cifra adulterada vira vazio (não vaza a cifra)', () => {
    const c = encrypt('81999998888') as string;
    expect(decrypt(c.slice(0, -4) + 'AAAA')).toBe('');
  });

  it('acha os caminhos, inclusive dentro de listas', () => {
    const o = { phone: 'x', customer: { phone: 'y', name: 'Ana' }, addresses: [{ street: 'a', city: 'Recife' }, { street: 'b', city: 'Olinda' }] };
    mapPaths(o, ['phone', 'customer.phone', 'addresses[].street'], encrypt);
    expect(isEncrypted(o.phone) && isEncrypted(o.customer.phone)).toBe(true);
    expect(o.customer.name).toBe('Ana');
    expect(o.addresses.every((a) => isEncrypted(a.street) && !isEncrypted(a.city))).toBe(true);
    mapPaths(o, ['phone', 'customer.phone', 'addresses[].street'], decrypt);
    expect(o).toEqual({ phone: 'x', customer: { phone: 'y', name: 'Ana' }, addresses: [{ street: 'a', city: 'Recife' }, { street: 'b', city: 'Olinda' }] });
  });

  it('atualizações: caminho direto, objeto inteiro, lista e índice do telefone', () => {
    const paths = ['customer.phone', 'customer.document', 'address.street', 'addresses[].street', 'phone'];
    const idx = { from: 'customer.phone', to: 'customer.phoneIdx' };
    const a: Record<string, any> = { 'customer.phone': '(81) 99876-5432' };
    encryptUpdate(a, paths, idx);
    expect(isEncrypted(a['customer.phone'])).toBe(true);
    expect(a['customer.phoneIdx']).toBe(phoneIndex('81998765432'));
    const b: Record<string, any> = { customer: { name: 'Ana', phone: '81 9876-5432', document: '12345678909' } };
    encryptUpdate(b, paths, idx);
    expect(b.customer.name).toBe('Ana');
    expect(isEncrypted(b.customer.phone) && isEncrypted(b.customer.document)).toBe(true);
    expect(b.customer.phoneIdx).toBe(phoneIndex('8198765432'));
    const c: Record<string, any> = { addresses: [{ street: 'Rua 2', city: 'Recife' }], phone: '1' , 'address.street': 'Rua 3' };
    encryptUpdate(c, paths);
    expect(isEncrypted(c.addresses[0].street) && !isEncrypted(c.addresses[0].city)).toBe(true);
    expect(isEncrypted(c.phone) && isEncrypted(c['address.street'])).toBe(true);
  });

  it('índice do telefone: mesmos 8 últimos dígitos, mesmo índice; curto demais não indexa', () => {
    expect(phoneIndex('+55 (81) 99876-5432')).toBe(phoneIndex('9876-5432'));
    expect(phoneIndex('81998765431')).not.toBe(phoneIndex('81998765432'));
    expect(phoneIndex('1234')).toBeNull();
    expect(phoneIndex('81998765432')).not.toContain('5432');
  });
});
