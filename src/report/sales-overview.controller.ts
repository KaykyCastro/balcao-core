import { BadRequestException, Controller, Get, Injectable, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Matches } from 'class-validator';
import { Model, Types } from 'mongoose';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { periodRange } from '../common/period';
import { Exchange } from '../exchange/schema/exchange.schema';
import { Sale } from '../sale/schema/sale.schema';
import { salesOverview } from './sales-overview.rules';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
class OverviewQuery {
  @Matches(DAY, { message: 'Data inválida (use AAAA-MM-DD)' }) from: string;
  @Matches(DAY, { message: 'Data inválida (use AAAA-MM-DD)' }) to: string;
}

@Injectable()
export class SalesOverviewService {
  constructor(@InjectModel(Sale.name) private readonly sales: Model<Sale>, @InjectModel(Exchange.name) private readonly exchanges: Model<Exchange>) {}

  async get(enterpriseId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('A data inicial vem depois da final.');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new BadRequestException('Escolha um período de até 1 ano.');
    const eid = new Types.ObjectId(enterpriseId);
    const createdAt = periodRange(from, to)!;
    const [sales, exchanges] = await Promise.all([
      this.sales.find({ enterpriseId: eid, createdAt }).select('channel status paymentMethod totalCents creditCents exchangeCents discountCents createdAt paymentEdits').lean(),
      this.exchanges.find({ enterpriseId: eid, createdAt }).select('returnedCents newCents creditCents refundCents createdAt').lean(),
    ]);
    return salesOverview(sales as never, exchanges as never, from, to);
  }
}

/** Resumo do período para a página "Gestão de vendas". */
@Controller('sales-overview')
export class SalesOverviewController {
  constructor(private readonly svc: SalesOverviewService) {}

  @Get()
  get(@CurrentEnterprise() eid: string, @Query() q: OverviewQuery) {
    return this.svc.get(eid, q.from, q.to);
  }
}
