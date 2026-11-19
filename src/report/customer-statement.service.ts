import { Controller, Get, Injectable, NotFoundException, Param, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { IsOptional, Matches } from 'class-validator';
import { Model, Types } from 'mongoose';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { periodRange } from '../common/period';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { CustomerCredit } from '../customer/schema/customer-credit.schema';
import { CustomerPayment } from '../customer/schema/customer-payment.schema';
import { CustomerSchema } from '../customer/schema/customer.schema';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { Exchange } from '../exchange/schema/exchange.schema';
import { Sale } from '../sale/schema/sale.schema';
import { buildLedger, dueOf, itemsText, type LedgerEvent } from './customer-statement.rules';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
class StatementQuery {
  @IsOptional() @Matches(DAY, { message: 'Data inválida (use AAAA-MM-DD)' }) from?: string;
  @IsOptional() @Matches(DAY, { message: 'Data inválida (use AAAA-MM-DD)' }) to?: string;
}
const METHOD_LABEL: Record<string, string> = { cash: 'Dinheiro', pix: 'Pix', card: 'Cartão', other: 'Outro', fiado: 'Pagamento posterior', online: 'Loja online', credit: 'Crédito da loja', exchange: 'Troca' };
const code = (id: unknown) => String(id).slice(-6).toUpperCase();

/**
 * Extrato completo de um cliente (tela do cliente e relatório para imprimir/enviar): resumo de sempre, a conta do
 * pagamento posterior com saldo corrido (customer-statement.rules.ts), compras, recebimentos, crédito da loja e trocas
 * do período. Tudo da empresa logada.
 */
@Injectable()
export class CustomerStatementService {
  constructor(
    @InjectModel(Sale.name) private readonly sales: Model<Sale>,
    @InjectModel(CustomerPayment.name) private readonly payments: Model<CustomerPayment>,
    @InjectModel(CustomerSchema.name) private readonly customers: Model<CustomerSchema>,
    @InjectModel(Exchange.name) private readonly exchanges: Model<Exchange>,
    @InjectModel(CustomerCredit.name) private readonly credits: Model<CustomerCredit>,
    private readonly enterprises: EnterpriseService,
  ) {}

  async get(enterpriseId: string, customerId: string, from?: string, to?: string) {
    const eid = new Types.ObjectId(enterpriseId), cid = new Types.ObjectId(customerId);
    const c = await this.customers.findOne({ _id: cid, enterpriseId: eid }).lean();
    if (!c) throw new NotFoundException('Cliente não encontrado');
    const range = periodRange(from, to);
    const inRange = (d?: Date | null) => !!d && (!range?.$gte || d >= range.$gte) && (!range?.$lt || d < range.$lt);

    const [allSales, pays, exch, credits, ent] = await Promise.all([
      this.sales.find({ enterpriseId: eid, customerId: cid }).select('status channel paymentMethod totalCents creditCents exchangeCents discountCents subtotalCents discount serviceCents items createdAt cancelledAt staff').sort({ createdAt: 1 }).lean(),
      this.payments.find({ enterpriseId: eid, customerId: cid }).sort({ createdAt: 1 }).lean(),
      this.exchanges.find({ enterpriseId: eid, customerId: cid }).sort({ createdAt: 1 }).lean(),
      this.credits.find({ enterpriseId: eid, customerId: cid }).sort({ createdAt: 1 }).lean(),
      this.enterprises.findEnterpriseById(enterpriseId),
    ]);

    // Conta do pagamento posterior: compras (+), cancelamentos, sobras de troca e pagamentos (−).
    const events: LedgerEvent[] = [];
    for (const s of allSales) {
      if (s.paymentMethod !== 'fiado' || !s.createdAt) continue;
      const due = dueOf(s);
      if (!due) continue;
      events.push({ at: s.createdAt, kind: 'sale', amountCents: due, ref: String(s._id), detail: `Nº ${code(s._id)} · ${itemsText(s.items)}` });
      if (s.status === 'cancelled') events.push({ at: s.cancelledAt ?? s.createdAt, kind: 'cancel', amountCents: -due, ref: String(s._id), detail: `Compra Nº ${code(s._id)} cancelada` });
    }
    for (const p of pays) {
      const at = (p as { createdAt?: Date }).createdAt;
      if (at) events.push({ at, kind: 'payment', amountCents: -p.amountCents, ref: String(p._id), detail: `Pagamento em ${METHOD_LABEL[p.method] ?? p.method}` });
    }
    for (const x of exch) {
      if (x.debtAbatedCents > 0 && x.createdAt) events.push({ at: x.createdAt, kind: 'exchange', amountCents: -x.debtAbatedCents, ref: String(x._id), detail: `Devolução da compra Nº ${x.saleCode}` });
    }
    const ledger = buildLedger(events, c.debitCents ?? 0, { from: range?.$gte ?? null, to: range?.$lt ?? null });

    // Resumo de sempre (compras concluídas por forma de pagamento).
    const done = allSales.filter((s) => s.status === 'completed');
    const byMethod: Record<string, number> = {};
    for (const s of done) {
      const due = dueOf(s);
      if (due) byMethod[s.paymentMethod] = (byMethod[s.paymentMethod] ?? 0) + due; // dinheiro novo, pela forma
      if (s.creditCents) byMethod.credit = (byMethod.credit ?? 0) + s.creditCents;
      if (s.exchangeCents) byMethod.exchange = (byMethod.exchange ?? 0) + s.exchangeCents;
    }
    const cancelled = allSales.filter((s) => s.status === 'cancelled');
    const all = buildLedger(events, c.debitCents ?? 0);

    const periodSales = allSales.filter((s) => !range || inRange(s.createdAt));
    return {
      store: { name: ent.name, cnpj: ent.cnpj ?? '', logo: /^https:\/\//.test(ent.logo ?? '') ? ent.logo : '' },
      customer: {
        id: String(c._id), name: c.name, phone: c.numberWithPrefix ?? '', email: (c as { email?: string }).email ?? '', address: c.address ?? '',
        debitCents: c.debitCents ?? 0, creditCents: (c as { creditCents?: number }).creditCents ?? 0, since: (c as { createdAt?: Date }).createdAt ?? null,
      },
      period: range ? { from: from ?? null, to: to ?? null } : null,
      generatedAt: new Date(),
      summary: {
        purchases: { count: done.length, totalCents: done.reduce((n, s) => n + s.totalCents, 0), firstAt: done[0]?.createdAt ?? null, lastAt: done[done.length - 1]?.createdAt ?? null },
        byMethod,
        cancelled: { count: cancelled.length, totalCents: cancelled.reduce((n, s) => n + s.totalCents, 0) },
        fiado: { boughtCents: all.totals.boughtCents, paidCents: all.totals.paidCents, otherCents: all.totals.cancelledCents + all.totals.exchangeCents, previousCents: all.totals.openingAdjustCents },
        exchanges: { count: exch.length, returnedCents: exch.reduce((n, x) => n + x.returnedCents, 0) },
      },
      ledger,
      purchases: periodSales.reverse().slice(0, 500).map((s) => ({
        id: String(s._id), code: code(s._id), at: s.createdAt, status: s.status, channel: s.channel ?? 'pos', method: s.paymentMethod,
        totalCents: s.totalCents, dueCents: dueOf(s), creditCents: s.creditCents ?? 0, exchangeCents: s.exchangeCents ?? 0, discountCents: s.discountCents ?? 0,
        // Sem desconto no carrinho, o subtotal é a soma dos itens (o total pode ter taxa de serviço da mesa).
        subtotalCents: s.subtotalCents ?? s.items.reduce((n, i) => n + i.totalCents, 0),
        discount: s.discount ? { mode: s.discount.mode, value: s.discount.value, reason: s.discount.reason ?? '' } : null,
        serviceCents: s.serviceCents ?? 0,
        staff: s.staff?.name ?? '',
        items: s.items.map((i) => ({
          name: i.productName, code: i.productCode, quantity: i.quantity, unitPriceCents: i.unitPriceCents,
          // Preço de antes quando a unidade saiu em promoção (mostra o riscado e quanto economizou).
          originalUnitPriceCents: i.originalUnitPriceCents && i.originalUnitPriceCents > i.unitPriceCents ? i.originalUnitPriceCents : null,
          totalCents: i.totalCents, options: (i.options ?? []).map((o) => o.name).join(', '), note: i.note ?? '',
        })),
      })),
      payments: pays.filter((p) => !range || inRange((p as { createdAt?: Date }).createdAt)).reverse().map((p) => ({ id: String(p._id), at: (p as { createdAt?: Date }).createdAt, method: p.method, amountCents: p.amountCents })),
      credits: credits.filter((r) => !range || inRange((r as { createdAt?: Date }).createdAt)).reverse().map((r) => ({ at: (r as { createdAt?: Date }).createdAt, kind: r.kind, amountCents: r.amountCents, balanceAfterCents: r.balanceAfterCents })),
      exchanges: exch.filter((x) => !range || inRange(x.createdAt)).reverse().map((x) => ({
        id: String(x._id), at: x.createdAt, saleCode: x.saleCode, returned: x.returned.map((r) => `${r.quantity}× ${r.productName}`).join(', '),
        returnedCents: x.returnedCents, newCents: x.newCents, toPayCents: x.toPayCents, debtAbatedCents: x.debtAbatedCents, creditCents: x.creditCents, refundCents: x.refundCents,
      })),
    };
  }
}

/** Extrato do cliente (`from`/`to` = dias de Brasília; sem eles, desde o começo). */
@Controller('customer')
export class CustomerStatementController {
  constructor(private readonly svc: CustomerStatementService) {}

  @Get(':id/statement')
  get(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Query() q: StatementQuery) {
    return this.svc.get(eid, id, q.from, q.to);
  }
}
