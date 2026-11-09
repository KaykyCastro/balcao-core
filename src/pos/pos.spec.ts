import { Types } from 'mongoose';
import { crc16, normalizePixKey, pixPayload } from '../common/pix';
import { mpOrder } from '../mercadopago/mercadopago.client';
import { stoneOrder } from './stone.client';
import { PosService } from './pos.service';

describe('Pix copia e cola (BR Code)', () => {
  it('bate com o exemplo do manual do Banco Central (CRC 1D3D)', () => {
    const p = pixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' });
    expect(p).toBe('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D');
  });
  it('valor, txid e textos sem acento; CRC sempre confere', () => {
    const p = pixPayload({ key: '+5585999990000', name: 'Padaria São João Ltda Fortaleza Centro', city: 'Fortaleza', amountCents: 1990, txid: 'abc-123' });
    expect(p).toContain('540519.90');
    expect(p).toContain('5925Padaria Sao Joao Ltda For');
    expect(p).toContain('0506abc123');
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
  });
  it('normaliza e confere a chave pelo tipo', () => {
    expect(normalizePixKey('cnpj', '11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizePixKey('phone', '(85) 99999-0000')).toBe('+5585999990000');
    expect(normalizePixKey('email', 'Loja@Ex.com')).toBe('loja@ex.com');
    expect(normalizePixKey('cpf', '123')).toBeNull();
    expect(normalizePixKey('random', 'nao-e-uuid')).toBeNull();
  });
});

describe('respostas dos provedores', () => {
  it('Mercado Pago: processada = paga; cancelada/expirada = falhou; senão espera', () => {
    expect(mpOrder({ id: 'ORD1', status: 'processed', transactions: { payments: [{ id: 'PAY1', status: 'processed', amount: '10.00', payment_method: { id: 'master', type: 'credit_card', installments: 2 } }] } })).toMatchObject({ state: 'paid', paymentId: 'PAY1', amountCents: 1000, method: 'master', installments: 2 });
    expect(mpOrder({ id: 'ORD2', status: 'at_terminal', transactions: { payments: [{ status: 'at_terminal' }] } }).state).toBe('pending');
    expect(mpOrder({ id: 'ORD3', status: 'expired' }).state).toBe('failed');
    expect(mpOrder({ id: 'ORD4', status: 'action_required', transactions: { payments: [{ payment_method: { id: 'pix', qr_code: '000201...', qr_code_base64: 'iVBOR' } }] } })).toMatchObject({ state: 'pending', qrCode: '000201...', qrBase64: 'iVBOR' });
  });
  it('Stone: pedido pago com dados do cartão', () => {
    expect(stoneOrder({ id: 'or_1', status: 'paid', charges: [{ status: 'paid', amount: 1990, payment_method: 'credit_card', last_transaction: { installments: 3, acquirer_auth_code: '123456', card: { brand: 'Visa' } } }] })).toMatchObject({ state: 'paid', amountCents: 1990, brand: 'Visa', installments: 3, authCode: '123456' });
    expect(stoneOrder({ id: 'or_2', status: 'pending', charges: [] }).state).toBe('pending');
    expect(stoneOrder({ id: 'or_3', status: 'canceled' }).state).toBe('failed');
  });
});

// ------------------------------------------------------------------ serviço de cobrança

const EID = new Types.ObjectId().toHexString();
const PID = new Types.ObjectId().toHexString();
function setup(cfg: any = {}) {
  const docs = new Map<string, any>();
  const asDoc = (d: any) => d;
  const payments: any = {
    findOne: jest.fn(async (q: any) => [...docs.values()].find((d) => (q._id ? String(d._id) === String(q._id) : d.clientKey === q.clientKey)) ?? null),
    findById: jest.fn(async (id: any) => docs.get(String(id)) ?? null),
    create: jest.fn(async (d: any) => { const doc = asDoc({ status: 'pending', saleId: null, paidAt: null, detail: null, failReason: '', confirmedBy: '', qrCode: null, qrBase64: null, providerRef: '', ...d }); docs.set(String(d._id), doc); return doc; }),
    updateOne: jest.fn(async (q: any, u: any) => { const d = docs.get(String(q._id)); if (!d) return; if (q.status?.$in && !q.status.$in.includes(d.status)) return; Object.assign(d, u.$set); }),
    findOneAndUpdate: jest.fn(async (q: any, u: any) => { const d = docs.get(String(q._id)); if (!d || (q.status && d.status !== q.status)) return null; Object.assign(d, u.$set); return d; }),
    find: jest.fn(() => ({ limit: async () => [...docs.values()] })),
  };
  const config = { pix: { mode: 'key', keyType: 'cnpj', key: '11222333000181', holder: 'Padaria Boa', city: 'Fortaleza' }, point: { enabled: true, terminalId: 'PAX_A910__SMARTPOS123', label: 'Caixa 1' }, stone: { enabled: false, serial: '', skHint: '' }, ...cfg };
  const configs: any = { findOne: jest.fn(() => ({ select: () => ({ lean: async () => config }), lean: async () => config })), updateOne: jest.fn() };
  let mpState = 'pending';
  const mp: any = {
    createPointOrder: jest.fn(async () => ({ id: 'ORD-1', state: 'pending' })),
    createPixOrder: jest.fn(async () => ({ id: 'ORD-PIX', state: 'pending', qrCode: '000201pix', qrBase64: 'iVBOR' })),
    order: jest.fn(async () => ({ id: 'ORD-1', state: mpState, status: mpState === 'paid' ? 'processed' : 'at_terminal', statusDetail: '', paymentId: 'PAY-9', method: 'visa', installments: 1, methodType: 'credit_card' })),
    cancelOrder: jest.fn(async () => ({ id: 'ORD-1', state: 'failed' })),
  };
  const sales: any = {
    quote: jest.fn(async () => ({ totalCents: 4590 })),
    create: jest.fn(async (_e: string, dto: any, key: string, payment: any) => ({ _id: new Types.ObjectId(), totalCents: 4590, paymentMethod: dto.paymentMethod, key, payment })),
    findById: jest.fn(async () => ({ _id: 'sale', totalCents: 4590 })),
  };
  const stores: any = { getOrCreate: jest.fn(async () => ({ _id: new Types.ObjectId(), mp: { userId: '555', nickname: 'LOJA' } })), mpAccessToken: jest.fn(async () => 'APP_USR-x') };
  const enterprises: any = { findEnterpriseById: jest.fn(async () => ({ name: 'Padaria Boa' })) };
  const customers: any = { getCustomerById: jest.fn(async () => ({})) };
  const stone: any = { partnerReady: false };
  const svc = new PosService(configs, payments, mp, stone, sales, stores, enterprises, customers, {} as never);
  return { svc, docs, mp, sales, setPaid: () => { mpState = 'paid'; } };
}
const items = [{ productId: PID, quantity: 2 }];

describe('cobrança no balcão', () => {
  it('maquininha Point: envia o valor calculado no servidor; só vira venda quando o Mercado Pago confirma', async () => {
    const t = setup();
    const c = await t.svc.charge(EID, { method: 'credit', provider: 'mp_point', installments: 3, items, clientKey: 'cx-aaaaaaaa' });
    expect(t.mp.createPointOrder.mock.calls[0][0]).toMatchObject({ terminalId: 'PAX_A910__SMARTPOS123', amountCents: 4590, type: 'credit_card', installments: 3 });
    expect(c).toMatchObject({ status: 'pending', amountCents: 4590, saleId: null });
    expect(await t.svc.status(EID, c.id)).toMatchObject({ status: 'pending' });
    expect(t.sales.create).not.toHaveBeenCalled();
    t.setPaid();
    const done = await t.svc.status(EID, c.id);
    expect(done.status).toBe('paid');
    expect(t.sales.create).toHaveBeenCalledTimes(1);
    const [, dto, key, payment] = t.sales.create.mock.calls[0];
    expect(dto).toMatchObject({ paymentMethod: 'card', items });
    expect(key).toBe(`pos:${c.id}`);
    expect(payment).toMatchObject({ provider: 'mp_point', method: 'credit', installments: 3, amountCents: 4590, paymentId: 'PAY-9' });
    await t.svc.status(EID, c.id); // consultar de novo não cria outra venda
    expect(t.sales.create).toHaveBeenCalledTimes(1);
  });

  it('mesmo botão duas vezes (mesma chave) não cria duas cobranças', async () => {
    const t = setup();
    const a = await t.svc.charge(EID, { method: 'debit', provider: 'mp_point', items, clientKey: 'cx-bbbbbbbb' });
    const b = await t.svc.charge(EID, { method: 'debit', provider: 'mp_point', items, clientKey: 'cx-bbbbbbbb' });
    expect(a.id).toBe(b.id);
    expect(t.mp.createPointOrder).toHaveBeenCalledTimes(1);
  });

  it('Pix na chave: QR com o valor; o caixa confirma e gera a venda', async () => {
    const t = setup();
    const c = await t.svc.charge(EID, { method: 'pix', provider: 'pix_key', items });
    expect(c.qrCode).toMatch(/^000201.*br\.gov\.bcb\.pix.*1411222333000181.*540545\.90.*6304[0-9A-F]{4}$/);
    const done = await t.svc.confirm(EID, c.id, 'caixa@loja.com');
    expect(done.status).toBe('paid');
    expect(t.sales.create.mock.calls[0][1]).toMatchObject({ paymentMethod: 'pix' });
    expect(t.docs.get(c.id).confirmedBy).toBe('caixa@loja.com');
  });

  it('maquininha não se confirma à mão; Pix não vai para cartão', async () => {
    const t = setup();
    const c = await t.svc.charge(EID, { method: 'credit', provider: 'mp_point', items });
    await expect(t.svc.confirm(EID, c.id, 'x')).rejects.toMatchObject({ status: 400 });
    await expect(t.svc.charge(EID, { method: 'credit', provider: 'pix_key', items })).rejects.toMatchObject({ status: 400 });
  });

  it('Pix pelo Mercado Pago devolve o QR dinâmico', async () => {
    const t = setup({ pix: { mode: 'mercadopago', keyType: 'cnpj', key: '', holder: '', city: '' } });
    const c = await t.svc.charge(EID, { method: 'pix', provider: 'mp_pix', items });
    expect(c).toMatchObject({ qrCode: '000201pix', qrBase64: 'iVBOR', status: 'pending' });
    expect(t.mp.createPixOrder.mock.calls[0][0]).toMatchObject({ amountCents: 4590 });
  });

  it('cancelar no caixa cancela na maquininha e não vira venda', async () => {
    const t = setup();
    const c = await t.svc.charge(EID, { method: 'credit', provider: 'mp_point', items });
    expect(await t.svc.cancel(EID, c.id)).toMatchObject({ status: 'canceled' });
    expect(t.mp.cancelOrder).toHaveBeenCalled();
    expect(t.sales.create).not.toHaveBeenCalled();
  });

  it('pagou com a tela fechada: a conferência automática registra a venda', async () => {
    const t = setup();
    await t.svc.charge(EID, { method: 'credit', provider: 'mp_point', items });
    t.setPaid();
    expect(await t.svc.reconcile()).toBe(1);
    expect(t.sales.create).toHaveBeenCalledTimes(1);
  });
});
