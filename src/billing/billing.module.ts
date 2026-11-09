import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { BillingScheduler } from './billing.scheduler';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { EnterprisesModule } from '../enterprise/enterprise.module';
import { FeeEntry, FeeEntrySchemaFactory } from './schema/fee-entry.schema';
import { Invoice, InvoiceSchemaFactory } from './schema/invoice.schema';
import { PaymentEvent, PaymentEventSchemaFactory } from './schema/payment-event.schema';
import { EnterpriseSchema, EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';
import { MessagesModule } from '../messages/messages.module';
import { BillingNoticeService } from './billing-notice.service';
import { AutopayService } from './autopay.service';
import { WhatsAppClient } from './whatsapp.client';

@Module({
  imports: [
    EnterprisesModule,
    MercadoPagoModule,
    MongooseModule.forFeature([
      { name: FeeEntry.name, schema: FeeEntrySchemaFactory },
      { name: Invoice.name, schema: InvoiceSchemaFactory },
      { name: PaymentEvent.name, schema: PaymentEventSchemaFactory },
      { name: EnterpriseSchema.name, schema: EnterpriseSchemaFactory },
    ]),
    MessagesModule,
  ],
  controllers: [BillingController],
  providers: [BillingService, BillingScheduler, BillingNoticeService, AutopayService, WhatsAppClient],
  exports: [BillingService],
})
export class BillingModule {}
