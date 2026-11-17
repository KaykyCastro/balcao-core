import { ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { CashWithdrawal } from './schema/cash-withdrawal.schema';
import { CustomerSchema } from '../customer/schema/customer.schema';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale } from '../sale/schema/sale.schema';
import { CustomerPayment } from '../customer/schema/customer-payment.schema';
import type { StaffSession } from '../staff/staff.service';
import { CashClosing } from './schema/cash-closing.schema';
import { Exchange } from '../exchange/schema/exchange.schema';
import { centsOk, dayOf, dayRange, daySummary } from './cash-close.rules';

/** Quem está vendo: o dono (staff null) ou um colaborador. Sem "relatórios", o colaborador só vê e fecha o dia de hoje. */
type Viewer = StaffSession | null;

@Injectable()
export class CashCloseService {
  constructor(
    @InjectModel(Sale.name) private readonly sales: Model<Sale>,
    @InjectModel(CustomerPayment.name) private readonly payments: Model<CustomerPayment>,
    @InjectModel(CashClosing.name) private readonly closings: Model<CashClosing>,
    @InjectModel(Exchange.name) private readonly exchanges: Model<Exchange>,
    @InjectModel(CashWithdrawal.name) private readonly withdrawals: Model<CashWithdrawal>,
    @InjectModel(CustomerSchema.name) private readonly customers: Model<CustomerSchema>,
    @Optional() private readonly enterprises?: EnterpriseService,
  ) {}

  private allowDay(day: string, who: Viewer) {
    if (who && !who.permissions.includes('reports') && day !== dayOf()) {
      throw new ForbiddenException({ code: 'CLOSE_ONLY_TODAY', message: 'Seu acesso permite ver e fechar só o caixa de hoje.' });
    }
  }

  private async summarize(enterpriseId: string, day: string, openingCents = 0) {
    const { from, to } = dayRange(day);
    const eid = new Types.ObjectId(enterpriseId);
    const [sales, payments, exchanges, withdrawals] = await Promise.all([
      this.sales.find({ enterpriseId: eid, createdAt: { $gte: from, $lt: to } })
        .select('paymentMethod status totalCents discountCents creditCents exchangeCents createdAt staff items.productName items.quantity items.totalCents').lean(),
      this.payments.find({ enterpriseId: eid, createdAt: { $gte: from, $lt: to } }).select('customerId method amountCents createdAt').sort({ createdAt: 1 }).lean(),
      this.exchanges.find({ enterpriseId: eid, createdAt: { $gte: from, $lt: to } }).select('returnedCents refundCents refundMethod creditCents').lean(),
      this.withdrawals.find({ enterpriseId: eid, day }).sort({ createdAt: 1 }).lean(),
    ]);
    // Nome do cliente em cada pagamento de fiado (a tabela do fechamento mostra quem pagou).
    const ids = [...new Set(payments.map((p) => String(p.customerId)).filter(Boolean))];
    const names = new Map((await this.customers.find({ enterpriseId: eid, _id: { $in: ids.map((x) => new Types.ObjectId(x)) } }).select('name').lean()).map((c) => [String(c._id), c.name]));
    return {
      ...daySummary(day, sales as never, payments as never, openingCents, exchanges as never, withdrawals),
      fiadoPayments: payments.map((p) => ({ at: (p as { createdAt?: Date }).createdAt ?? null, customerId: String(p.customerId), customerName: names.get(String(p.customerId)) ?? 'Cliente apagado', method: p.method, amountCents: p.amountCents })),
      withdrawals: withdrawals.map((w) => ({ id: String(w._id), at: w.createdAt ?? null, amountCents: w.amountCents, reason: w.reason, by: w.by?.name ?? 'Dono' })),
    };
  }

  /** Resumo do dia + o fechamento já feito (se houver). */
  async day(enterpriseId: string, day: string | undefined, who: Viewer) {
    const d = day || dayOf();
    this.allowDay(d, who);
    const closing = await this.closings.findOne({ enterpriseId: new Types.ObjectId(enterpriseId), day: d }).lean();
    const summary = await this.summarize(enterpriseId, d, closing?.openingCents ?? 0);
    return { today: dayOf(), summary, closing };
  }

  /** Fecha (ou refaz o fechamento de) um dia: guarda o contado, o esperado e a diferença. */
  async close(enterpriseId: string, dto: { day?: string; openingCents?: number; countedCents: number; note?: string }, who: Viewer) {
    const d = dto.day || dayOf();
    this.allowDay(d, who);
    const opening = centsOk(dto.openingCents ?? 0, 'Troco inicial');
    const counted = centsOk(dto.countedCents, 'Dinheiro contado');
    const s = await this.summarize(enterpriseId, d, opening);
    const eid = new Types.ObjectId(enterpriseId);
    const closing = await this.closings.findOneAndUpdate(
      { enterpriseId: eid, day: d },
      {
        $set: {
          openingCents: opening, countedCents: counted, expectedCents: s.cash.expectedCents, diffCents: counted - s.cash.expectedCents,
          note: (dto.note ?? '').trim().slice(0, 300),
          totals: { count: s.sales.count, revenueCents: s.sales.revenueCents, drawerTotalCents: s.drawerTotalCents, onlineCents: s.online.totalCents, fiadoSoldCents: s.fiado.soldCents, fiadoReceivedCents: s.fiado.receivedCents, withdrawnCents: s.cash.withdrawnCents },
          closedBy: who ? { name: who.name, staffId: new Types.ObjectId(who.id) } : { name: 'Dono', staffId: null },
        },
        $inc: { revisions: 1 },
      },
      { upsert: true, new: true, lean: true },
    );
    return { today: dayOf(), summary: s, closing };
  }

  /**
   * Retirada de dinheiro da gaveta (sangria) no caixa de HOJE: valor, motivo e a senha do dono (mesmo com um
   * colaborador no caixa). Sai do "esperado na gaveta" do fechamento e fica registrada para sempre.
   */
  async withdraw(enterpriseId: string, dto: { amountCents: number; reason: string; ownerPassword: string }, who: Viewer) {
    const amount = centsOk(dto.amountCents, 'Valor da retirada');
    if (amount < 1) throw new ConflictException({ statusCode: 409, code: 'WITHDRAW_INVALID', message: 'Informe o valor retirado.' });
    const reason = (dto.reason ?? '').replace(/\s+/g, ' ').trim();
    if (reason.length < 3) throw new ConflictException({ statusCode: 409, code: 'WITHDRAW_REASON', message: 'Explique o motivo da retirada (ex.: compra de material, depósito no banco).' });
    if (!this.enterprises) throw new ForbiddenException('Indisponível');
    await this.enterprises.verifyOwnerPassword(enterpriseId, dto.ownerPassword);
    const day = dayOf();
    await this.withdrawals.create({ enterpriseId: new Types.ObjectId(enterpriseId), day, amountCents: amount, reason: reason.slice(0, 200), by: who ? { name: who.name, staffId: new Types.ObjectId(who.id) } : { name: 'Dono', staffId: null } });
    return this.day(enterpriseId, day, who);
  }

  /** Últimos fechamentos (mais recentes primeiro). */
  async list(enterpriseId: string, limit: number, who: Viewer) {
    if (who && !who.permissions.includes('reports')) throw new ForbiddenException({ code: 'CLOSE_ONLY_TODAY', message: 'Seu acesso permite ver só o caixa de hoje.' });
    return this.closings.find({ enterpriseId: new Types.ObjectId(enterpriseId) }).sort({ day: -1 }).limit(limit).lean();
  }
}
