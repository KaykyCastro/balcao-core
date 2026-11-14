import { OptionsError, type OptionGroup } from '../products/options.rules';
import { groupSaleLines, splitPromoUnits } from './lines.rules';

const SIZE: OptionGroup = { id: 'tam', name: 'Tamanho', min: 1, max: 1, repeat: false, pricing: 'sum', items: [
  { id: 'p', name: 'P', description: '', priceCents: 0, available: true }, { id: 'gg', name: 'GG', description: '', priceCents: 1000, available: true }, { id: 'x', name: 'XGG', description: '', priceCents: 0, available: false }] };
const products: Record<string, { name: string; options?: OptionGroup[] }> = { a: { name: 'Camiseta', options: [SIZE] }, b: { name: 'Boné' } };
const of = (id: string) => products[id];

describe('venda no balcão com opções do produto', () => {
  it('junta escolhas iguais e separa as diferentes; o estoque conta pelo produto', () => {
    const g = groupSaleLines([
      { productId: 'a', quantity: 1, options: [{ g: 'tam', i: 'p', q: 1 }] },
      { productId: 'a', quantity: 2, options: [{ g: 'tam', i: 'gg', q: 1 }] },
      { productId: 'a', quantity: 1, options: [{ g: 'tam', i: 'p', q: 1 }] },
      { productId: 'b', quantity: 3 },
    ], of);
    expect(g.get('a')!.quantity).toBe(4);
    expect(g.get('a')!.lines.map((l) => [l.quantity, l.extraCents, l.picked[0].name])).toEqual([[2, 0, 'P'], [2, 1000, 'GG']]);
    expect(g.get('b')).toEqual({ quantity: 3, lines: [{ quantity: 3, extraCents: 0, picked: [], note: '' }] });
  });

  it('observação diferente vira outra linha', () => {
    const g = groupSaleLines([{ productId: 'b', quantity: 1, note: 'presente' }, { productId: 'b', quantity: 1 }], of);
    expect(g.get('b')!.lines.map((l) => l.note)).toEqual(['presente', '']);
  });

  it('recusa escolha que falta, opção esgotada ou grupo inexistente', () => {
    expect(() => groupSaleLines([{ productId: 'a', quantity: 1 }], of)).toThrow(OptionsError);
    expect(() => groupSaleLines([{ productId: 'a', quantity: 1, options: [{ g: 'tam', i: 'x', q: 1 }] }], of)).toThrow(/acabou/);
    expect(() => groupSaleLines([{ productId: 'b', quantity: 1, options: [{ g: 'tam', i: 'p', q: 1 }] }], of)).toThrow(OptionsError);
  });

  it('promoção sobre o preço base, dividida entre as linhas; o adicional vale para todas', () => {
    const g = groupSaleLines([{ productId: 'a', quantity: 2, options: [{ g: 'tam', i: 'p', q: 1 }] }, { productId: 'a', quantity: 2, options: [{ g: 'tam', i: 'gg', q: 1 }] }], of);
    const parts = splitPromoUnits(g.get('a')!.lines, 3, 3000, 5000);
    expect(parts.map((x) => [x.quantity, x.unitCents, x.promo])).toEqual([[2, 3000, true], [1, 4000, true], [1, 6000, false]]);
    expect(parts.reduce((s, x) => s + x.quantity, 0)).toBe(4);
  });
});
