import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ReportService } from './report.service';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';

class OverviewQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  days: number = 30;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000)
  lowStock: number = 5;
}

class YearQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100)
  year: number = new Date().getFullYear();
}
class LimitQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(48)
  limit: number = 12;
}

@Controller('report')
export class ReportController {
  constructor(private readonly report: ReportService) {}

  /** `?days=30&lowStock=5` — totais, ticket médio, por forma de pagamento, por dia, mais vendidos, fiado e estoque baixo. */
  @Get('overview')
  overview(@CurrentEnterprise() eid: string, @Query() q: OverviewQuery) {
    return this.report.overview(eid, q.days, q.lowStock);
  }

  /** `?year=2026` — visão anual com comparação com o ano anterior. */
  @Get('yearly')
  yearly(@CurrentEnterprise() eid: string, @Query() q: YearQuery) {
    return this.report.yearly(eid, q.year);
  }

  /** `?lowStock=5` — esgotados, acabando (pelo ritmo de vendas) e parados. */
  @Get('stock')
  stock(@CurrentEnterprise() eid: string, @Query() q: OverviewQuery) {
    return this.report.stock(eid, q.lowStock);
  }

  /** `?limit=12` — produtos mais vendidos para a frente de caixa. */
  @Get('popular-products')
  popular(@CurrentEnterprise() eid: string, @Query() q: LimitQuery) {
    return this.report.popular(eid, q.limit);
  }
}
