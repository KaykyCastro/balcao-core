import { ConfigService } from '@nestjs/config';
import { MercadoPagoClient, statementDescriptorOf } from './mercadopago.client';

describe('Mercado Pago: itens de qualidade da integração', () => {
  it('texto da fatura do cartão: sem acento, só letras e números, até 22 caracteres', () => {
    expect(statementDescriptorOf('Pele Boa — Cosméticos & Cia')).toBe('PELE BOA COSMETICOS CI');
    expect(statementDescriptorOf('Ótica São João')).toBe('OTICA SAO JOAO');
    expect(statementDescriptorOf('')).toBe('');
  });

  const make = (env: Record<string, string>) => {
    const calls: { body: any; headers: Record<string, string> }[] = [];
    const mp = new MercadoPagoClient(new ConfigService(env));
    let fail = 0;
    global.fetch = jest.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body), headers: init.headers });
      if (fail-- > 0) return { ok: false, status: 400, json: async () => ({ message: 'invalid config' }) } as any;
      return { ok: true, status: 201, json: async () => ({ id: 'ORD1', status: 'action_required', transactions: { payments: [{ payment_method: { qr_code: 'x' } }] } }) } as any;
    }) as any;
    return { mp, calls, failNext: (n: number) => { fail = n; } };
  };

  it('Pix do caixa leva nome na fatura, URLs de retorno HTTPS, 3DS e o e-mail do comprador; x-platform-id quando configurado', async () => {
    const t = make({ FRONTEND_URL: 'https://balcao.com.br', MP_PLATFORM_ID: 'PLAT123' });
    await t.mp.createPixOrder({ accessToken: 'TK', amountCents: 1990, reference: 'r1', idem: 'i1', payerEmail: 'ana@x.com', statementDescriptor: 'Pele Boa' });
    const { body, headers } = t.calls[0];
    expect(body.payer.email).toBe('ana@x.com');
    expect(body.config.statement_descriptor).toBe('PELE BOA');
    expect(body.config.online).toMatchObject({ success_url: 'https://balcao.com.br/app/vendas?pix=aprovado', failure_url: expect.stringMatching(/^https:/), pending_url: expect.stringMatching(/^https:/), transaction_security: { liability_shift: 'required' } });
    expect(headers['X-Platform-Id']).toBe('PLAT123');
  });

  it('sem HTTPS (desenvolvimento) não manda URLs de retorno; sem MP_PLATFORM_ID não manda o cabeçalho', async () => {
    const t = make({ FRONTEND_URL: 'http://localhost:5173' });
    await t.mp.createPixOrder({ accessToken: 'TK', amountCents: 1990, reference: 'r1', idem: 'i1', payerEmail: 'ana@x.com' });
    expect(t.calls[0].body.config.online.success_url).toBeUndefined();
    expect(t.calls[0].headers['X-Platform-Id']).toBeUndefined();
  });

  it('se o Mercado Pago recusar os campos de qualidade (400), o Pix do caixa sai sem eles', async () => {
    const t = make({ FRONTEND_URL: 'https://balcao.com.br' });
    t.failNext(1);
    const o = await t.mp.createPixOrder({ accessToken: 'TK', amountCents: 1990, reference: 'r1', idem: 'i1', payerEmail: 'ana@x.com' });
    expect(o.id).toBe('ORD1');
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].body.config).toBeUndefined();
    expect(t.calls[1].headers['X-Idempotency-Key']).toBe('i1-b');
  });
});

import { payerOf } from './mercadopago.client';
describe('Checkout Pro: itens de qualidade', () => {
  it('pagador: nome e sobrenome separados, CPF/CNPJ, telefone e endereço só quando existem', () => {
    expect(payerOf({ name: 'Ana Maria Souza', email: 'a@x.com', phone: '(85) 99999-0000', document: '123.456.789-09', address: { cep: '60000-000', street: 'Rua A', number: '10' } })).toEqual({
      name: 'Ana', surname: 'Maria Souza', email: 'a@x.com', phone: { area_code: '85', number: '999990000' },
      identification: { type: 'CPF', number: '12345678909' }, address: { zip_code: '60000000', street_name: 'Rua A', street_number: '10' },
    });
    expect(payerOf({ name: 'Bella Moda', document: '12345678000190' }).identification).toEqual({ type: 'CNPJ', number: '12345678000190' });
    expect(payerOf({ name: 'Mesa 4' })).toEqual({ name: 'Mesa', surname: '4' });
    expect(payerOf({ name: 'Ana', document: '123' }).identification).toBeUndefined();
  });

  it('preferência leva categoria e descrição do item, nome na fatura sem acento e o limite de parcelas', async () => {
    let body: any;
    global.fetch = jest.fn(async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, status: 201, json: async () => ({ id: 'P1', init_point: 'https://mp/x' }) } as any; }) as any;
    const mp = new MercadoPagoClient(new ConfigService({}));
    await mp.createPreference({ accessToken: 'T', orderId: 'o1', items: [{ title: 'Batom', quantity: 2, unitCents: 1990 }], payer: { name: 'Ana Souza', email: 'a@x.com' }, backUrl: 'https://x/y', statementDescriptor: 'Pele Boa Cosméticos', maxInstallments: 6 });
    expect(body.items[0]).toMatchObject({ id: '1', title: 'Batom', description: 'Batom', category_id: 'others', quantity: 2, unit_price: 19.9 });
    expect(body.statement_descriptor).toBe('PELE BOA COSMETICOS');
    expect(body.payment_methods.installments).toBe(6);
    expect(body.payer).toMatchObject({ name: 'Ana', surname: 'Souza', email: 'a@x.com' });
    expect(body.back_urls.success).toBe('https://x/y');
    expect(body.external_reference).toBe('o1');
  });
});
