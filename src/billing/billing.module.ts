import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { BillingScheduler } from './billing.scheduler';
import { InfinitePayClient } from './infinitepay.client';
import { EnterprisesModule } from '../enterprise/enterprise.module';
import { FeeEntry, FeeEntrySchemaFactory } from './schema/fee-entry.schema';
import { Invoice, InvoiceSchemaFactory } from './schema/invoice.schema';
import { PaymentEvent, PaymentEventSchemaFactory } from './schema/payment-event.schema';

@Module({
  imports: [
    EnterprisesModule,
    MongooseModule.forFeature([
      { name: FeeEntry.name, schema: FeeEntrySchemaFactory },
      { name: Invoice.name, schema: InvoiceSchemaFactory },
      { name: PaymentEvent.name, schema: PaymentEventSchemaFactory },
    ]),
  ],
  controllers: [BillingController],
  providers: [BillingService, BillingScheduler, InfinitePayClient],
  exports: [BillingService, InfinitePayClient],
})
export class BillingModule {}
