import { Types } from 'mongoose';
import { ProductService } from './product.service';
import { sanitizeOptions } from './options.rules';

describe('biblioteca de opções da loja', () => {
  it('junta grupos iguais de produtos diferentes e conta quantos usam', async () => {
    const cor = () => sanitizeOptions([{ name: 'Cor', min: 1, max: 1, items: [{ name: 'Azul' }, { name: 'Preto' }] }]);
    const rows = [
      { name: 'Camiseta', options: cor() },
      { name: 'Moletom', options: [...cor(), ...sanitizeOptions([{ name: 'Tecido', min: 0, max: 1, items: [{ name: 'Algodão' }, { name: 'Linho', priceCents: 1500 }] }])] },
      { name: 'Boné', options: sanitizeOptions([{ name: 'Cor', min: 1, max: 1, items: [{ name: 'Azul' }, { name: 'Vermelho' }] }]) },
    ];
    const model: any = { find: jest.fn(() => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }) })) };
    const svc = new ProductService(model, {} as any, {} as any);
    const r = await svc.optionLibrary(String(new Types.ObjectId()));
    expect(r.items.map((x) => [x.group.name, x.products, x.example])).toEqual([['Cor', 2, 'Camiseta'], ['Tecido', 1, 'Moletom'], ['Cor', 1, 'Boné']]);
  });
});
