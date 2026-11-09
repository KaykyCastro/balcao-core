import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Connection, Types } from 'mongoose';
import { ProductService } from '../products/product.service';

/**
 * "Vendidos" do cartão: soma das unidades em vendas não canceladas (balcão, online e mesa), por produto.
 * Recalcula ao subir e de hora em hora (barato e sempre fiel às vendas, sem contador para dessincronizar).
 */
@Injectable()
export class SoldCountScheduler implements OnApplicationBootstrap {
  private readonly log = new Logger('SoldCount');
  constructor(@InjectConnection() private readonly connection: Connection, private readonly products: ProductService) {}

  onApplicationBootstrap() { if (process.env.NODE_ENV !== 'test') setTimeout(() => void this.run(), 15_000); }

  @Cron(CronExpression.EVERY_HOUR)
  async run() {
    try {
      const sales = this.connection.models.Sale?.collection ?? this.connection.collection('sales');
      const rows = await sales.aggregate<{ _id: Types.ObjectId; sold: number }>([
        { $match: { status: { $ne: 'cancelled' } } }, { $unwind: '$items' }, { $match: { 'items.productId': { $ne: null } } },
        { $group: { _id: '$items.productId', sold: { $sum: '$items.quantity' } } },
      ], { allowDiskUse: true }).toArray();
      await this.products.setSoldCounts(rows.filter((r) => r._id).map((r) => ({ id: new Types.ObjectId(String(r._id)), sold: r.sold })));
      if (rows.length) this.log.log(`Vendidos atualizados em ${rows.length} produto(s)`);
    } catch (e) { this.log.error((e as Error).message); }
  }
}
