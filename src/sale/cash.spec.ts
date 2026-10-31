import { BadRequestException } from '@nestjs/common';
import { cashChange } from './cash';

describe('troco no dinheiro', () => {
  it('calcula o troco', () => {
    expect(cashChange('cash', 4590, 5000)).toEqual({ cashReceivedCents: 5000, changeCents: 410 });
  });
  it('valor exato: troco zero', () => {
    expect(cashChange('cash', 4590, 4590)).toEqual({ cashReceivedCents: 4590, changeCents: 0 });
  });
  it('sem valor informado: sem troco registrado', () => {
    expect(cashChange('cash', 4590)).toEqual({ cashReceivedCents: null, changeCents: null });
    expect(cashChange('pix', 4590, null)).toEqual({ cashReceivedCents: null, changeCents: null });
  });
  it('recusa valor menor que o total', () => {
    expect(() => cashChange('cash', 4590, 4000)).toThrow(BadRequestException);
    expect(() => cashChange('cash', 4590, 4000)).toThrow(/menor que o total/);
  });
  it('recusa valor recebido em outra forma de pagamento', () => {
    expect(() => cashChange('pix', 4590, 5000)).toThrow(/só vale para pagamento em dinheiro/);
  });
  it('recusa valor quebrado ou negativo', () => {
    expect(() => cashChange('cash', 100, 150.5)).toThrow(BadRequestException);
    expect(() => cashChange('cash', 0, -1)).toThrow(BadRequestException);
  });
});
