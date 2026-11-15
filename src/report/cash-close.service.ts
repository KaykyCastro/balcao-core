import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale } from '../sale/schema/sale.schema';
import { CustomerPayment } from '../customer/schema/customer-payment.schema';
import type { StaffSession } from '../staff/staff.service';
import { CashClosing } from './schema/cash-closing.schema';
import { centsOk, dayOf, dayRange, daySummary } from './cash-close.rules';

/** Quem está vendo: o dono (staff null) ou um colaborador. Sem "relatórios", o colaborador só vê e fecha o dia de hoje. */
type Viewer = StaffSession | null;

@Injectable()
export class CashCloseService {
  constructor(
    @InjectModel(Sale.name) private readonly sales: Model<Sale>,
    @InjectModel(CustomerPayment.name) private readonly payments: Model<CustomerPayment>,
    @InjectModel(CashClosing.name) private readonly closings: Model<CashClosing>,
  ) {}

  private allowDay(day: string, who: Viewer) {
    if (who && !who.permissions.includes('reports') && day !== dayOf()) {
      throw new ForbiddenException({ code: 'CLOSE_ONLY_TODAY', message: 'Seu acesso permite ver e fechar só o caixa de hoje.' });
    }
  }

  private async summarize(enterpriseId: string, day: string, openingCents = 0) {
    const { from, to } = dayRange(day);
    const eid = new Types.ObjectId(enterpriseId);
    const [sales, payments] = await Promise.all([
      this.sales.find({ enterpriseId: eid, createdAt: { $gte: from, $lt: to } })
        .select('paymentMethod status totalCents discountCents createdAt staff items.productName items.quantity items.totalCents').lean(),
      this.payments.find({ enterpriseId: eid, createdAt: { $gte: from, $lt: to } }).select('method amountCents').lean(),
    ]);
    return daySummary(day, sales as never, payments as never, openingCents);
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
          totals: { count: s.sales.count, revenueCents: s.sales.revenueCents, drawerTotalCents: s.drawerTotalCents, onlineCents: s.online.totalCents, fiadoSoldCents: s.fiado.soldCents, fiadoReceivedCents: s.fiado.receivedCents },
          closedBy: who ? { name: who.name, staffId: new Types.ObjectId(who.id) } : { name: 'Dono', staffId: null },
        },
        $inc: { revisions: 1 },
      },
      { upsert: true, new: true, lean: true },
    );
    return { today: dayOf(), summary: s, closing };
  }

  /** Últimos fechamentos (mais recentes primeiro). */
  async list(enterpriseId: string, limit: number, who: Viewer) {
    if (who && !who.permissions.includes('reports')) throw new ForbiddenException({ code: 'CLOSE_ONLY_TODAY', message: 'Seu acesso permite ver só o caixa de hoje.' });
    return this.closings.find({ enterpriseId: new Types.ObjectId(enterpriseId) }).sort({ day: -1 }).limit(limit).lean();
  }
}
