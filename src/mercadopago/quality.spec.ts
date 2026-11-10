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
