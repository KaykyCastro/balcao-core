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
      if (fail-- > 0) return new Response(JSON.stringify({ message: 'invalid config' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'ORD1', status: 'action_required', transactions: { payments: [{ payment_method: { qr_code: 'x' } }] } }), { status: 201, headers: { 'content-type': 'application/json' } });
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

  it('checkout vira ordem (API de Orders): itens, pagador, nome na fatura, parcelas, sem boleto, URLs de retorno', async () => {
    let body: any; let url = '';
    global.fetch = jest.fn(async (u: string, init: any) => { url = u; body = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'ORD01ABCDEFGHIJKLMN', checkout_url: 'https://www.mercadopago.com.br/checkout/v1/redirect?order_id=ORD01ABCDEFGHIJKLMN' }), { status: 201, headers: { 'content-type': 'application/json' } }); }) as any;
    const mp = new MercadoPagoClient(new ConfigService({}));
    const r = await mp.createPreference({ accessToken: 'T', orderId: 'o1', items: [{ title: 'Batom', quantity: 2, unitCents: 1990 }], payer: { name: 'Ana Souza', email: 'a@x.com', document: '12345678909' }, backUrl: 'https://x/y', statementDescriptor: 'Pele Boa Cosméticos', maxInstallments: 6, marketplaceFeeCents: 120 });
    expect(url).toMatch(/\/v1\/orders$/);
    expect(r).toEqual({ id: 'ORD01ABCDEFGHIJKLMN', initPoint: expect.stringMatching(/^https:/) });
    expect(body).toMatchObject({ type: 'online', processing_mode: 'manual', total_amount: '39.80', external_reference: 'o1', marketplace_fee: '1.20' });
    expect(body.items[0]).toMatchObject({ title: 'Batom', unit_price: '19.90', quantity: 2, description: 'Batom', category_id: 'others' });
    expect(body.payer).toMatchObject({ email: 'a@x.com', first_name: 'Ana', last_name: 'Souza', identification: { type: 'CPF', number: '12345678909' } });
    expect(body.config.statement_descriptor).toBe('PELE BOA COSMETICOS');
    expect(body.config.payment_method).toEqual({ not_allowed_types: ['ticket'], max_installments: 6 });
    expect(body.config.online).toMatchObject({ success_url: 'https://x/y', auto_return: 'approved', retries: { allowed: true } }); // recusa não encerra a ordem
  });

  it('ordem completa recusada: a segunda tentativa ainda leva itens completos, pagador com nome, nome na fatura e parcelas', async () => {
    const bodies: any[] = [];
    global.fetch = jest.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? new Response(JSON.stringify({ message: 'invalid' }), { status: 400, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify({ id: 'ORD01ABCDEFGHIJKLMN', checkout_url: 'https://mp/x' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as any;
    const mp = new MercadoPagoClient(new ConfigService({}));
    await mp.createPreference({ accessToken: 'T', orderId: 'o1', items: [{ title: 'Taxa', quantity: 1, unitCents: 500, description: 'Taxa mensal', categoryId: 'services' }], payer: { name: 'Ana Souza', email: 'a@x.com', document: '12345678909' }, backUrl: 'https://x/y', statementDescriptor: 'Balcao', maxInstallments: 3 });
    expect(bodies).toHaveLength(2);
    const safe = bodies[1];
    expect(safe.items[0]).toEqual({ title: 'Taxa', unit_price: '5.00', quantity: 1, description: 'Taxa mensal', category_id: 'services', external_code: '1' });
    expect(safe.payer).toEqual({ email: 'a@x.com', first_name: 'Ana', last_name: 'Souza' });
    expect(safe.config).toMatchObject({ statement_descriptor: 'BALCAO', payment_method: { max_installments: 3 } });
    expect(safe.config.online.transaction_security).toBeUndefined();
    expect(safe.additional_info).toBeUndefined();
  });

  it('se o Mercado Pago recusar um campo opcional (400), a ordem sai só com o essencial', async () => {
    const bodies: any[] = [];
    global.fetch = jest.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? new Response(JSON.stringify({ message: 'invalid' }), { status: 400, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify({ id: 'ORD01ABCDEFGHIJKLMN', checkout_url: 'https://mp/x' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as any;
    const mp = new MercadoPagoClient(new ConfigService({}));
    await mp.createPreference({ accessToken: 'T', orderId: 'o1', items: [{ title: 'Taxa', quantity: 1, unitCents: 500 }], payer: { name: 'Mesa 4' }, backUrl: 'https://x/y' });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].config).toEqual({ online: expect.objectContaining({ success_url: 'https://x/y', retries: { allowed: true } }) });
    expect(bodies[1].payer).toBeUndefined(); // sem e-mail não manda pagador (o e-mail é obrigatório quando vai)
  });
});
