import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomerModule } from '../customer/customer.module';
import { ProductModule } from '../products/product.module';
import { SaleModule } from '../sale/sale.module';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';
import { ExchangeController } from './exchange.controller';
import { ExchangeService } from './exchange.service';
import { Exchange, ExchangeSchema } from './schema/exchange.schema';

/** Trocas e devoluções no balcão (ver exchange.rules.ts). */
@Module({
  imports: [MongooseModule.forFeature([{ name: Exchange.name, schema: ExchangeSchema }, { name: Sale.name, schema: SaleSchemaFactory }]), SaleModule, ProductModule, CustomerModule],
  controllers: [ExchangeController],
  providers: [ExchangeService],
  exports: [ExchangeService],
})
export class ExchangeModule {}
