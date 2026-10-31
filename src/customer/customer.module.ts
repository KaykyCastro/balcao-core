import { Module } from '@nestjs/common';
import { CustomerService } from './customer.service';
import { CustomerController } from './customer.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomerSchema, CustomerSchemaFactory } from './schema/customer.schema';
import { CustomerPayment, CustomerPaymentSchemaFactory } from './schema/customer-payment.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CustomerSchema.name, schema: CustomerSchemaFactory },
      { name: CustomerPayment.name, schema: CustomerPaymentSchemaFactory },
    ]),
  ],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
