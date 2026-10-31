import { BadRequestException } from '@nestjs/common';

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Pagamento em dinheiro: valor entregue pelo cliente e troco. O troco é sempre calculado aqui (servidor),
 * nunca aceito do navegador. Sem valor informado, a venda segue sem troco registrado.
 */
export function cashChange(paymentMethod: string, totalCents: number, receivedCents?: number | null): { cashReceivedCents: number | null; changeCents: number | null } {
  if (receivedCents === undefined || receivedCents === null) return { cashReceivedCents: null, changeCents: null };
  if (paymentMethod !== 'cash') throw new BadRequestException('Valor recebido só vale para pagamento em dinheiro');
  if (!Number.isInteger(receivedCents) || receivedCents < 0) throw new BadRequestException('Valor recebido inválido');
  if (receivedCents < totalCents) throw new BadRequestException(`Valor recebido (${brl(receivedCents)}) é menor que o total da venda (${brl(totalCents)})`);
  return { cashReceivedCents: receivedCents, changeCents: receivedCents - totalCents };
}
