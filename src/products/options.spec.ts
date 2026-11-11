import { lineName, minExtraCents, OptionsError, priceChoice, sanitizeOptions } from './options.rules';

const pizza = sanitizeOptions([
  { id: 'qj', name: 'Escolha 3 queijos', min: 3, max: 3, items: [{ id: 'mu', name: 'Mussarela' }, { id: 'pr', name: 'Provolone' }, { id: 'go', name: 'Gorgonzola', priceCents: 400 }, { id: 'pa', name: 'Parmesão' }] },
  { id: 'bd', name: 'Borda', min: 0, max: 1, items: [{ id: 'ca', name: 'Catupiry', priceCents: 800 }, { id: 'ch', name: 'Cheddar', priceCents: 800, available: false }] },
  { id: 'sb', name: 'Sabores', min: 1, max: 2, pricing: 'max', items: [{ id: 'm', name: 'Margherita', priceCents: 4000 }, { id: 'c', name: 'Camarão', priceCents: 6500 }] },
  { id: 'ad', name: 'Adicionais', min: 0, max: 5, repeat: true, items: [{ id: 'bc', name: 'Bacon', priceCents: 500 }] },
]);

describe('adicionais do produto (cardápio)', () => {
  it('cadastro: normaliza, mantém ids válidos e recusa grupo incoerente', () => {
    expect(pizza[0]).toMatchObject({ id: 'qj', min: 3, max: 3, repeat: false, pricing: 'sum' });
    expect(pizza[1].items[1].available).toBe(false);
    const g = sanitizeOptions([{ id: '<script>', name: '  Ponto  da carne ', items: [{ name: 'Ao ponto' }] }]);
    expect(g[0].id).toMatch(/^[a-f0-9]{10}$/);
    expect(g[0].name).toBe('Ponto da carne');
    expect(g[0]).toMatchObject({ min: 0, max: 1 });
    expect(() => sanitizeOptions([{ name: 'X', items: [] }])).toThrow(OptionsError);
    expect(() => sanitizeOptions([{ name: 'X', min: 2, max: 1, items: [{ name: 'a' }, { name: 'b' }] }])).toThrow(/mínimo/);
    expect(() => sanitizeOptions([{ name: 'X', max: 3, items: [{ name: 'a' }] }])).toThrow(/máximo/); // sem repetir, máx. = nº de opções
    expect(() => sanitizeOptions([{ name: 'X', items: [{ name: 'a', priceCents: -1 }] }])).toThrow(/Preço/);
    expect(() => sanitizeOptions([{ name: 'X', items: [{ name: 'a', priceCents: 1.5 }] }])).toThrow(/Preço/);
    expect(() => sanitizeOptions(Array.from({ length: 13 }, () => ({ name: 'g', items: [{ name: 'a' }] })))).toThrow(/12/);
  });

  it('pizza de 3 queijos: soma só o queijo que tem preço; borda e sabor pelo mais caro', () => {
    const r = priceChoice(pizza, [
      { g: 'qj', i: 'mu', q: 1 }, { g: 'qj', i: 'go', q: 1 }, { g: 'qj', i: 'pa', q: 1 },
      { g: 'bd', i: 'ca', q: 1 }, { g: 'sb', i: 'm', q: 1 }, { g: 'sb', i: 'c', q: 1 },
    ], 'Pizza');
    expect(r.extraCents).toBe(400 + 800 + 6500);
    expect(r.picked.filter((p) => p.group === 'Sabores')).toEqual([{ group: 'Sabores', name: 'Margherita', qty: 1, priceCents: 6500 }, { group: 'Sabores', name: 'Camarão', qty: 1, priceCents: 0 }]);
    // A ordem em que o cliente clicou não muda a linha do carrinho.
    const again = priceChoice(pizza, [{ g: 'sb', i: 'c', q: 1 }, { g: 'sb', i: 'm', q: 1 }, { g: 'bd', i: 'ca', q: 1 }, { g: 'qj', i: 'pa', q: 1 }, { g: 'qj', i: 'mu', q: 1 }, { g: 'qj', i: 'go', q: 1 }]);
    expect(again.key).toBe(r.key);
  });

  it('média e repetição', () => {
    const avg = sanitizeOptions([{ id: 's', name: 'Sabores', min: 2, max: 2, pricing: 'avg', items: [{ id: 'a', name: 'A', priceCents: 4000 }, { id: 'b', name: 'B', priceCents: 4501 }] }]);
    expect(priceChoice(avg, [{ g: 's', i: 'a', q: 1 }, { g: 's', i: 'b', q: 1 }]).extraCents).toBe(4251);
    const base = [{ g: 'qj', i: 'mu', q: 1 }, { g: 'qj', i: 'pr', q: 1 }, { g: 'qj', i: 'pa', q: 1 }, { g: 'sb', i: 'm', q: 1 }];
    expect(priceChoice(pizza, [...base, { g: 'ad', i: 'bc', q: 3 }]).extraCents).toBe(4000 + 1500);
  });

  it('recusa escolha fora das regras, opção esgotada e id inventado', () => {
    const base = [{ g: 'qj', i: 'mu', q: 1 }, { g: 'qj', i: 'pr', q: 1 }, { g: 'qj', i: 'pa', q: 1 }, { g: 'sb', i: 'm', q: 1 }];
    expect(() => priceChoice(pizza, base.slice(1))).toThrow('Escolha pelo menos 3 em "Escolha 3 queijos"');
    expect(() => priceChoice(pizza, [...base, { g: 'qj', i: 'go', q: 1 }])).toThrow('Escolha até 3');
    expect(() => priceChoice(pizza, [...base, { g: 'bd', i: 'ch', q: 1 }])).toThrow('acabou');
    expect(() => priceChoice(pizza, [...base, { g: 'bd', i: 'zz', q: 1 }])).toThrow('mudaram');
    expect(() => priceChoice(pizza, [...base.slice(0, 2), { g: 'qj', i: 'mu', q: 1 }, { g: 'sb', i: 'm', q: 1 }])).toThrow('duas vezes');
    expect(() => priceChoice(pizza, [...base, { g: 'bd', i: 'ca', q: 2 }])).toThrow('uma vez');
    expect(() => priceChoice(pizza, [...base, { g: 'ad', i: 'bc', q: 6 }])).toThrow('Escolha até 5');
    expect(() => priceChoice(pizza, [])).toThrow(OptionsError);
    expect(priceChoice([], []).extraCents).toBe(0);
  });

  it('"a partir de" e texto da linha', () => {
    expect(minExtraCents(pizza)).toBe(0 + 4000); // 3 queijos sem custo + sabor mais barato
    const r = priceChoice(pizza, [{ g: 'qj', i: 'mu', q: 1 }, { g: 'qj', i: 'pr', q: 1 }, { g: 'qj', i: 'pa', q: 1 }, { g: 'sb', i: 'm', q: 1 }, { g: 'ad', i: 'bc', q: 2 }]);
    expect(lineName('Pizza grande', r.picked, 'sem cebola')).toBe('Pizza grande (Escolha 3 queijos: Mussarela, Provolone, Parmesão · Sabores: Margherita · Adicionais: 2x Bacon · Obs.: sem cebola)');
    expect(lineName('Coca', [], '')).toBe('Coca');
  });
});
