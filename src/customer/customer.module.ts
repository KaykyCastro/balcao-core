import { Module } from '@nestjs/common';
import { CustomerService } from './customer.service';
import { CustomerController } from './customer.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomerSchema, CustomerSchemaFactory } from './schema/customer.schema';
import { CustomerPayment, CustomerPaymentSchemaFactory } from './schema/customer-payment.schema';
import { Shopper, ShopperSchemaFactory } from '../shopper/schema/shopper.schema';
import { CustomerLinkRequest, CustomerLinkRequestSchemaFactory } from './schema/link-request.schema';
import { CustomerInviteCode, CustomerInviteCodeSchemaFactory } from './schema/invite-code.schema';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CustomerSchema.name, schema: CustomerSchemaFactory },
      { name: CustomerPayment.name, schema: CustomerPaymentSchemaFactory },
      { name: Shopper.name, schema: ShopperSchemaFactory },
      { name: CustomerLinkRequest.name, schema: CustomerLinkRequestSchemaFactory },
      { name: CustomerInviteCode.name, schema: CustomerInviteCodeSchemaFactory },
    ]),
    MessagesModule,
  ],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
