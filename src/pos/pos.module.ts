import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PosConfig, PosConfigSchemaFactory, PosPayment, PosPaymentSchemaFactory } from './schema/pos.schema';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { PosScheduler } from './pos.scheduler';
import { StoneClient } from './stone.client';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { SaleModule } from '../sale/sale.module';
import { StoreModule } from '../store/store.module';
import { EnterprisesModule } from '../enterprise/enterprise.module';
import { CustomerModule } from '../customer/customer.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PosConfig.name, schema: PosConfigSchemaFactory }, { name: PosPayment.name, schema: PosPaymentSchemaFactory }]),
    MercadoPagoModule, SaleModule, StoreModule, EnterprisesModule, CustomerModule,
  ],
  controllers: [PosController],
  providers: [PosService, PosScheduler, StoneClient],
})
export class PosModule {}
