import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminBootstrap } from './admin.bootstrap';
import { AuditLog, AuditLogSchemaFactory } from './audit.schema';
import { EnterprisesModule } from '../enterprise/enterprise.module';
import { BillingModule } from '../billing/billing.module';
import { MessagesModule } from '../messages/messages.module';
import { EnterpriseSchema, EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { CustomerSchema, CustomerSchemaFactory } from '../customer/schema/customer.schema';
import { FeeEntry, FeeEntrySchemaFactory } from '../billing/schema/fee-entry.schema';
import { Invoice, InvoiceSchemaFactory } from '../billing/schema/invoice.schema';
import { Store, StoreSchemaFactory } from '../store/schema/store.schema';
import { Order, OrderSchemaFactory } from '../store/schema/order.schema';
import { Shopper, ShopperSchemaFactory } from '../shopper/schema/shopper.schema';
import { ShopperModule } from '../shopper/shopper.module';
import { StoreModule } from '../store/store.module';
import { AdminTrustService } from './admin-trust.service';

@Module({
  imports: [
    EnterprisesModule,
    BillingModule,
    MessagesModule,
    ShopperModule,
    StoreModule,
    MongooseModule.forFeature([
      { name: AuditLog.name, schema: AuditLogSchemaFactory },
      { name: EnterpriseSchema.name, schema: EnterpriseSchemaFactory },
      { name: Sale.name, schema: SaleSchemaFactory },
      { name: ProductSchema.name, schema: ProductSchemaFactory },
      { name: CustomerSchema.name, schema: CustomerSchemaFactory },
      { name: FeeEntry.name, schema: FeeEntrySchemaFactory },
      { name: Invoice.name, schema: InvoiceSchemaFactory },
      { name: Store.name, schema: StoreSchemaFactory },
      { name: Order.name, schema: OrderSchemaFactory },
      { name: Shopper.name, schema: ShopperSchemaFactory },
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminTrustService, AdminBootstrap],
})
export class AdminModule {}
