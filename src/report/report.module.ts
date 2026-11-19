import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { CustomerSchema, CustomerSchemaFactory } from '../customer/schema/customer.schema';
import { PromotionModule } from '../promotion/promotion.module';
import { CustomerPayment, CustomerPaymentSchemaFactory } from '../customer/schema/customer-payment.schema';
import { CashClosing, CashClosingSchemaFactory } from './schema/cash-closing.schema';
import { Exchange, ExchangeSchema } from '../exchange/schema/exchange.schema';
import { CashWithdrawal, CashWithdrawalSchema } from './schema/cash-withdrawal.schema';
import { EnterprisesModule } from '../enterprise/enterprise.module';
import { CashCloseController } from './cash-close.controller';
import { CashCloseService } from './cash-close.service';
import { SalesOverviewController, SalesOverviewService } from './sales-overview.controller';
import { CustomerStatementController, CustomerStatementService } from './customer-statement.service';
import { CustomerCredit, CustomerCreditSchema } from '../customer/schema/customer-credit.schema';

@Module({
  imports: [PromotionModule, MongooseModule.forFeature([
    { name: Sale.name, schema: SaleSchemaFactory },
    { name: ProductSchema.name, schema: ProductSchemaFactory },
    { name: CustomerSchema.name, schema: CustomerSchemaFactory },
    { name: CustomerPayment.name, schema: CustomerPaymentSchemaFactory },
    { name: CashClosing.name, schema: CashClosingSchemaFactory },
    { name: Exchange.name, schema: ExchangeSchema },
    { name: CashWithdrawal.name, schema: CashWithdrawalSchema },
    { name: CustomerCredit.name, schema: CustomerCreditSchema },
  ]), EnterprisesModule],
  controllers: [ReportController, CashCloseController, SalesOverviewController, CustomerStatementController],
  providers: [ReportService, CashCloseService, SalesOverviewService, CustomerStatementService],
})
export class ReportModule {}
