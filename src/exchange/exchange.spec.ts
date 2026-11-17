import { deadlineOf, paidByLine, parseSaleCode, priceReturns, returnValue, saleCode, settle, withinWindow } from './exchange.rules';

describe('trocas: regras', () => {
  it('lê o número do comprovante como ele aparece impresso', () => {
    expect(saleCode('6af8857463b72d58716e6770')).toBe('6E6770');
    expect(parseSaleCode('Nº 6E6770')).toEqual({ code: '6e6770' });
    expect(parseSaleCode(' 6e 67-70 ')).toEqual({ code: '6e6770' });
    expect(parseSaleCode('6af8857463b72d58716e6770')).toEqual({ id: '6af8857463b72d58716e6770' });
    expect(parseSaleCode('12345')).toBeNull();
    expect(parseSaleCode('nota 99')).toBeNull();
  });

  it('prazo de 7 dias corridos depois da compra', () => {
    const at = new Date('2026-11-10T15:00:00Z');
    expect(deadlineOf(at).toISOString()).toBe('2026-11-17T15:00:00.000Z');
    expect(withinWindow(at, new Date('2026-11-17T14:59:00Z'))).toBe(true);
    expect(withinWindow(at, new Date('2026-11-17T15:01:00Z'))).toBe(false);
  });

  it('desconto do carrinho repartido entre os itens, sem perder centavo', () => {
    // 3 linhas que somam 10.000; desconto de 1.000 (10%)
    const paid = paidByLine([{ totalCents: 5000 }, { totalCents: 3333 }, { totalCents: 1667 }], 1000);
    expect(paid.reduce((a, b) => a + b, 0)).toBe(9000);
    expect(paid).toEqual([4500, 3000, 1500]);
    expect(paidByLine([{ totalCents: 100 }, { totalCents: 100 }, { totalCents: 100 }], 100).reduce((a, b) => a + b, 0)).toBe(200);
    expect(paidByLine([{ totalCents: 2500 }], 0)).toEqual([2500]);
  });

  it('devolução parcial e depois o resto: soma exata do que foi pago', () => {
    // linha de 3 unidades que custou R$ 100,00 (com desconto)
    const a = returnValue(10000, 3, 0, 0, 1);
    const b = returnValue(10000, 3, 1, a, 2);
    expect(a).toBe(3333);
    expect(a + b).toBe(10000);
  });

  it('não devolve mais do que foi vendido, contando trocas anteriores', () => {
    const sale = { items: [{ quantity: 2, totalCents: 20000 }, { quantity: 1, totalCents: 5000 }], discountCents: 2500 };
    const r = priceReturns(sale, [], [{ line: 0, quantity: 1 }]);
    expect(r.returnedCents).toBe(9000); // linha 0 pagou 18.000 (com 2.000 de desconto): metade
    expect(() => priceReturns(sale, [{ line: 0, quantity: 2, totalCents: 18000 }], [{ line: 0, quantity: 1 }])).toThrow(/0 unidade/);
    expect(() => priceReturns(sale, [], [{ line: 5, quantity: 1 }])).toThrow(/não está nessa venda/);
    expect(() => priceReturns(sale, [], [{ line: 1, quantity: 1 }, { line: 1, quantity: 1 }])).toThrow(/duas vezes/);
  });

  it('acerto: valor devolvido paga os novos; falta → cliente paga; sobra → abate o fiado e vira crédito/dinheiro', () => {
    expect(settle(10000, 15000)).toMatchObject({ usedFromReturnCents: 10000, toPayCents: 5000, leftoverCents: 0, creditOrRefundCents: 0 });
    expect(settle(10000, 4000)).toMatchObject({ usedFromReturnCents: 4000, toPayCents: 0, leftoverCents: 6000, debtAbatedCents: 0, creditOrRefundCents: 6000 });
    expect(settle(10000, 0, 2500)).toMatchObject({ leftoverCents: 10000, debtAbatedCents: 2500, creditOrRefundCents: 7500 });
    expect(settle(10000, 10000)).toMatchObject({ toPayCents: 0, leftoverCents: 0 });
  });
});
