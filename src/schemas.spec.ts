import { AuditLogSchemaFactory } from './admin/audit.schema';
import { FeeEntrySchemaFactory } from './billing/schema/fee-entry.schema';
import { InvoiceSchemaFactory } from './billing/schema/invoice.schema';
import { PaymentEventSchemaFactory } from './billing/schema/payment-event.schema';
import { CategorySchemaFactory } from './category/schema/category.schema';
import { CustomerPaymentSchemaFactory } from './customer/schema/customer-payment.schema';
import { CustomerSchemaFactory } from './customer/schema/customer.schema';
import { MessageSchemaFactory } from './messages/message.schema';
import { ProductSchemaFactory } from './products/schema/product.schema';
import { SaleSchemaFactory } from './sale/schema/sale.schema';

/**
 * Regressão: `type: Types.ObjectId` (do mongoose) vira Mixed e o Mongoose deixa de converter ids de texto nas buscas,
 * então `deleteMany({ broadcastId: "<hex>" })` não casava com o ObjectId salvo. Os campos de id precisam ser ObjectId de verdade.
 */
describe('schemas: campos de id são ObjectId (não Mixed)', () => {
  const cases: [string, any, string[]][] = [
    ['audit', AuditLogSchemaFactory, ['actorId', 'targetEnterpriseId']],
    ['fee-entry', FeeEntrySchemaFactory, ['enterpriseId', 'saleId', 'invoiceId']],
    ['invoice', InvoiceSchemaFactory, ['enterpriseId']],
    ['payment-event', PaymentEventSchemaFactory, ['invoiceId']],
    ['category', CategorySchemaFactory, ['enterpriseId']],
    ['customer-payment', CustomerPaymentSchemaFactory, ['enterpriseId', 'customerId']],
    ['customer', CustomerSchemaFactory, ['enterpriseId']],
    ['message', MessageSchemaFactory, ['enterpriseId', 'broadcastId']],
    ['product', ProductSchemaFactory, ['enterpriseId', 'categoryId']],
    ['sale', SaleSchemaFactory, ['enterpriseId', 'customerId']],
  ];
  it.each(cases)('%s', (_n, schema, paths) => {
    for (const p of paths) expect(schema.path(p).instance).toBe('ObjectId');
  });
  it('itens da venda: productId é ObjectId', () => {
    expect((SaleSchemaFactory.path('items') as any).schema.path('productId').instance).toBe('ObjectId');
  });
  it('busca por id em texto é convertida para ObjectId (recolher aviso, taxa do mês etc.)', () => {
    const { model } = require('mongoose');
    const M = model('MsgCastTest', MessageSchemaFactory);
    const q = M.deleteMany({ $or: [{ broadcastId: '6ada88c1775f94b458a91cf0' }] });
    (q as any)._castConditions();
    expect(q.getFilter().$or[0].broadcastId.constructor.name).toBe('ObjectId');
  });
});
