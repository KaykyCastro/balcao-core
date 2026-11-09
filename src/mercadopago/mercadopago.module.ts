import { Module } from '@nestjs/common';
import { MercadoPagoClient } from './mercadopago.client';

/** Único provedor de pagamentos: faturas do sistema (conta do Balcão) e loja online (conta do lojista, com comissão). */
@Module({ providers: [MercadoPagoClient], exports: [MercadoPagoClient] })
export class MercadoPagoModule {}
