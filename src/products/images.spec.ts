import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ProductService, imagesOf } from './product.service';
import { ProductUpdateDto } from './dto/product-update.dto';

const png = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;
const q = (v: any) => { const p: any = Promise.resolve(v); p.select = () => p; p.lean = () => p; return p; };

function mk(current: any) {
  const model: any = {
    create: jest.fn(async (d) => ({ ...d, _id: 'x', toJSON() { return { ...this }; } })),
    findOne: jest.fn(() => q(current)),
    findOneAndUpdate: jest.fn((_f, u) => q({ ...current, ...u.$set })),
  };
  const cats: any = { findCategoryById: jest.fn(async () => ({})) };
  // Armazenamento falso: as fotos de teste passam direto (o fluxo do R2 tem testes próprios em storage.spec.ts).
  const storage = { resolveMany: async (_e: string, _k: string, v: string[]) => v, release: async () => undefined } as any;
  return { svc: new ProductService(model, cats, storage), model };
}

describe('fotos do produto', () => {
  it('produto antigo (só capa) aparece com 1 foto', () => {
    expect(imagesOf({ image: png(4) })).toEqual([png(4)]);
    expect(imagesOf({ image: '', images: [] })).toEqual([]);
  });

  it('criar com várias fotos: a primeira vira a capa', async () => {
    const { svc, model } = mk(null);
    const r: any = await svc.create('e', { name: 'Vestido', code: 'V1', price: 10, categoryId: 'c', images: [png(4), png(8)] } as any);
    expect(model.create.mock.calls[0][0]).toMatchObject({ image: png(4), images: [png(4), png(8)] });
    expect(r.images).toHaveLength(2);
  });

  it('app antigo mandando só `image` troca a capa e mantém as outras fotos', async () => {
    const { svc, model } = mk({ image: png(4), images: [png(4), png(8), png(12)] });
    await svc.update('e', 'p', { image: png(16) } as any);
    expect(model.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ image: png(16), images: [png(16), png(8), png(12)] });
    await svc.update('e', 'p', { image: '' } as any);
    expect(model.findOneAndUpdate.mock.calls[1][1].$set).toMatchObject({ image: png(8), images: [png(8), png(12)] });
  });

  it('reordenar: a nova primeira vira a capa; lista vazia tira as fotos', async () => {
    const { svc, model } = mk({ image: png(4), images: [png(4), png(8)] });
    await svc.update('e', 'p', { images: [png(8), png(4)] } as any);
    expect(model.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ image: png(8) });
    await svc.update('e', 'p', { images: [] } as any);
    expect(model.findOneAndUpdate.mock.calls[1][1].$set).toMatchObject({ image: '', images: [] });
  });

  it('valida: até 8 fotos e só png/jpeg/webp ou https', async () => {
    const nine = await validate(plainToInstance(ProductUpdateDto, { images: Array.from({ length: 9 }, () => png(4)) }));
    expect(nine.some((e) => e.property === 'images')).toBe(true);
    const bad = await validate(plainToInstance(ProductUpdateDto, { images: ['javascript:alert(1)'] }));
    expect(bad.some((e) => e.property === 'images')).toBe(true);
    const ok = await validate(plainToInstance(ProductUpdateDto, { images: [png(4), 'https://cdn.loja.com/a.jpg'] }));
    expect(ok).toHaveLength(0);
  });
});
