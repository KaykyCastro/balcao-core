import { ProductService } from './product.service';

const mk = (updated: any, found: any) => {
  const model: any = {
    findOneAndUpdate: jest.fn().mockResolvedValue(updated),
    findOne: jest.fn().mockReturnValue({ select: () => ({ session: () => Promise.resolve(found) }) }),
  };
  return { svc: new ProductService(model, {} as any), model };
};

describe('estoque', () => {
  it('produto com estoque: baixa quando há saldo', async () => {
    const { svc, model } = mk({ quantity: 1 }, null);
    await expect(svc.decreaseQuantity('e', 'p', 2)).resolves.toEqual({ tracked: true });
    expect(model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ trackStock: { $ne: false }, quantity: { $gte: 2 } });
  });
  it('saldo insuficiente → 409', async () => {
    const { svc } = mk(null, { trackStock: true, name: 'Caneta' });
    await expect(svc.decreaseQuantity('e', 'p', 5)).rejects.toMatchObject({ status: 409 });
  });
  it('serviço / estoque ilimitado: vende sem baixar e sem erro, mesmo com quantidade 0', async () => {
    const { svc } = mk(null, { trackStock: false, name: 'Corte de cabelo' });
    await expect(svc.decreaseQuantity('e', 'p', 999)).resolves.toEqual({ tracked: false });
  });
  it('produto inexistente → 404; quantidade inválida → 422', async () => {
    await expect(mk(null, null).svc.decreaseQuantity('e', 'p', 1)).rejects.toMatchObject({ status: 404 });
    await expect(mk(null, null).svc.decreaseQuantity('e', 'p', 0)).rejects.toMatchObject({ status: 422 });
    await expect(mk(null, null).svc.decreaseQuantity('e', 'p', 1.5)).rejects.toMatchObject({ status: 422 });
  });
  it('reposição (cancelamento) só atinge produto que controla estoque', async () => {
    const { svc, model } = mk(null, null);
    await svc.increaseQuantity('e', 'p', 2);
    expect(model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ trackStock: { $ne: false } });
  });
});
