import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schema/order.schema';
import { Store } from './schema/store.schema';
import { MelhorEnvioClient, type MeAddress } from './melhor-envio.client';
import { OrderService } from './order.service';
import { ProductService } from '../products/product.service';
import { open } from '../common/secret-box';
import { packageFor } from './store.rules';
import { autoConfirmOf } from './protection';
import { crossTenant } from '../common/security/tenant-guard.plugin';

const trackUrl = (code: string) => `https://www.melhorrastreio.com.br/rastreio/${encodeURIComponent(code)}`;

/**
 * Logística da loja online: compra e impressão de etiquetas no Melhor Envio (carteira do lojista)
 * e rastreio automático, que move o pedido para "Enviado" e "Entregue" e avisa o cliente.
 */
@Injectable()
export class LogisticsService {
  private readonly logger = new Logger(LogisticsService.name);
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Store.name) private readonly stores: Model<Store>,
    private readonly me: MelhorEnvioClient,
    private readonly orderService: OrderService,
    private readonly products: ProductService,
  ) {}

  private async storeMe(enterpriseId: Types.ObjectId | string) {
    const s = await this.stores.findOne({ enterpriseId: new Types.ObjectId(String(enterpriseId)) }).select('+shipping.melhorEnvio.tokenSealed').lean();
    const me = s?.shipping?.melhorEnvio;
    const token = open(me?.tokenSealed);
    if (!s || !me?.enabled || !token) throw new ConflictException('Conecte o Melhor Envio em Loja online → Entrega para comprar etiquetas.');
    return { store: s, me, token, sandbox: !!me.sandbox };
  }

  /** O que falta no remetente para a transportadora aceitar a etiqueta. */
  static senderMissing(me: { originCep?: string; sender?: Record<string, string> }): string[] {
    const s = me.sender ?? {};
    const need: [string, boolean][] = [['nome', !!s.name], ['telefone', !!s.phone], ['e-mail', !!s.email], ['CPF ou CNPJ', !!s.document], ['rua', !!s.street], ['número', !!s.number], ['bairro', !!s.district], ['cidade', !!s.city], ['UF', !!s.state], ['CEP de origem', !!me.originCep]];
    return need.filter(([, ok]) => !ok).map(([k]) => k);
  }

  private async mine(eid: string, id: string) {
    const o = await this.orders.findOne({ _id: id, enterpriseId: new Types.ObjectId(eid) });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    return o;
  }

  async buyLabel(eid: string, id: string, dto: { serviceId?: number; invoiceKey?: string }) {
    const o = await this.mine(eid, id);
    if (!['paid', 'preparing'].includes(o.status)) throw new ConflictException('Só dá para gerar etiqueta de pedido pago e ainda não enviado.');
    if (o.shipping.kind === 'pickup' || o.shipping.kind === 'table' || !o.address) throw new BadRequestException('Este pedido não tem entrega por transportadora.');
    if (o.label && ['generated', 'posted', 'delivered'].includes(o.label.status)) throw new ConflictException('Este pedido já tem etiqueta.');
    const { store, me, token, sandbox } = await this.storeMe(eid);
    const missing = LogisticsService.senderMissing(me as never);
    if (missing.length) throw new UnprocessableEntityException(`Complete o remetente em Loja online → Entrega: ${missing.join(', ')}.`);
    const serviceId = dto.serviceId ?? (o.shipping.optionId?.startsWith('me:') ? Number(o.shipping.optionId.slice(3)) : NaN);
    if (!Number.isInteger(serviceId) || serviceId < 1) throw new UnprocessableEntityException('Escolha a transportadora da etiqueta.');

    let labelId = o.label?.status === 'cart' ? o.label.id : '';
    try {
      if (!labelId) {
        const prods = await this.products.publicMany(eid, o.items.map((i) => String(i.productId))).catch(() => []);
        const dims = new Map<string, { weightGrams?: number; heightCm?: number; widthCm?: number; lengthCm?: number }>(prods.map((p) => [String(p._id), p as never] as const));
        const volume = packageFor(o.items.map((i) => ({ dims: dims.get(String(i.productId)) ?? {}, quantity: i.quantity })), store.shipping?.package);
        const snd = me.sender as Record<string, string>;
        const doc = (snd.document ?? '').replace(/\D/g, '');
        const from: MeAddress = {
          name: snd.name, phone: snd.phone, email: snd.email, ...(doc.length === 14 ? { company_document: doc } : { document: doc }),
          address: snd.street, number: snd.number, complement: snd.complement || undefined, district: snd.district, city: snd.city, state_abbr: snd.state, postal_code: String(me.originCep), country_id: 'BR',
        };
        const a = o.address;
        const to: MeAddress = {
          name: o.customer.name, phone: o.customer.phone, email: o.customer.email, ...(o.customer.document ? { document: o.customer.document } : {}),
          address: a.street, number: a.number, complement: a.complement || undefined, district: a.district, city: a.city, state_abbr: a.state, postal_code: a.cep, country_id: 'BR',
        };
        const r = await this.me.addToCart({
          sandbox, token, serviceId, from, to, volume, insuranceCents: o.subtotalCents, invoiceKey: dto.invoiceKey, tag: `Pedido #${o.number}`,
          products: o.items.map((i) => ({ name: i.productName, quantity: i.quantity, unitCents: i.unitPriceCents })),
        });
        labelId = r.id;
        await this.orders.updateOne({ _id: o._id }, { $set: { label: { provider: 'melhorenvio', id: r.id, protocol: r.protocol, serviceId, serviceName: o.shipping.carrier ? o.shipping.name : '', priceCents: r.priceCents, status: 'cart', createdAt: new Date(), printedAt: null, postedAt: null, error: '' } } });
      }
      await this.me.buy(sandbox, token, [labelId]);
      await this.me.generate(sandbox, token, [labelId]);
    } catch (e) {
      const msg = (e as Error).message;
      if (labelId) await this.orders.updateOne({ _id: o._id }, { $set: { 'label.error': /saldo|balance|insufficient/i.test(msg) ? 'Saldo insuficiente na carteira do Melhor Envio. Adicione saldo e tente de novo.' : msg } });
      throw e;
    }
    const now = new Date();
    await this.orders.updateOne({ _id: o._id }, {
      $set: { 'label.status': 'generated', 'label.error': '', ...(o.status === 'paid' ? { status: 'preparing' } : {}) },
      ...(o.status === 'paid' ? { $push: { history: { status: 'preparing', at: now, note: 'Etiqueta gerada' } } } : {}),
    });
    return this.orderService.present((await this.orders.findById(o._id))!);
  }

  /** Link do PDF com as etiquetas (várias de uma vez). Marca como impressas. */
  async print(eid: string, ids: string[]) {
    const rows = await this.orders.find({ _id: { $in: ids.map((x) => new Types.ObjectId(x)) }, enterpriseId: new Types.ObjectId(eid), 'label.status': { $in: ['generated', 'posted'] } });
    if (!rows.length) throw new NotFoundException('Nenhuma etiqueta gerada entre os pedidos escolhidos.');
    const { token, sandbox } = await this.storeMe(eid);
    const url = await this.me.printUrl(sandbox, token, rows.map((o) => o.label!.id));
    await this.orders.updateMany({ _id: { $in: rows.map((o) => o._id) } }, { $set: { 'label.printedAt': new Date() } });
    return { url, count: rows.length };
  }

  async cancel(eid: string, id: string) {
    const o = await this.mine(eid, id);
    if (!o.label || !['cart', 'generated'].includes(o.label.status)) throw new ConflictException('Só dá para cancelar etiqueta que ainda não foi postada.');
    const { token, sandbox } = await this.storeMe(eid);
    if (o.label.status === 'generated') await this.me.cancelLabel(sandbox, token, o.label.id, `Pedido #${o.number} cancelado pela loja`);
    await this.orders.updateOne({ _id: o._id }, { $set: { 'label.status': 'canceled' } });
    return this.orderService.present((await this.orders.findById(o._id))!);
  }

  /** Rastreio automático (de hora em hora): postado → Enviado com código; entregue → Entregue. */
  async syncTracking(): Promise<{ shipped: number; delivered: number }> {
    const out = { shipped: 0, delivered: 0 };
    const rows = await crossTenant(this.orders, 'rotina: rastreio das etiquetas de todas as lojas').find({ 'label.status': { $in: ['generated', 'posted'] }, status: { $in: ['paid', 'preparing', 'shipped'] } }).limit(500);
    const byEnt = new Map<string, OrderDocument[]>();
    for (const o of rows) byEnt.set(String(o.enterpriseId), [...(byEnt.get(String(o.enterpriseId)) ?? []), o]);
    for (const [eid, list] of byEnt) {
      let t: Record<string, { status: string; tracking: string }>;
      try { const { token, sandbox } = await this.storeMe(eid); t = await this.me.tracking(sandbox, token, list.map((o) => o.label!.id)); }
      catch (e) { this.logger.warn(`Rastreio da empresa ${eid} falhou: ${(e as Error).message}`); continue; }
      for (const o of list) {
        const r = t[o.label!.id]; if (!r) continue;
        const now = new Date();
        const code = r.tracking || o.label!.trackingCode || '';
        if ((r.status === 'posted' || r.status === 'delivered') && ['paid', 'preparing'].includes(o.status)) {
          const u = await this.orders.findOneAndUpdate({ _id: o._id, enterpriseId: o.enterpriseId, status: o.status }, {
            $set: { status: 'shipped', 'label.status': 'posted', 'label.trackingCode': code, 'label.postedAt': now, 'tracking.code': code, 'tracking.url': code ? trackUrl(code) : '' },
            $push: { history: { status: 'shipped', at: now, note: 'Postado (rastreio do Melhor Envio)' } },
          }, { new: true });
          if (u) { out.shipped++; void this.orderService.notifyCustomer(u); }
          o.status = 'shipped';
        }
        if (r.status === 'delivered' && o.status === 'shipped') {
          await this.orders.updateOne({ _id: o._id, enterpriseId: o.enterpriseId, status: 'shipped' }, {
            $set: { status: 'delivered', 'label.status': 'delivered', ...(o.protection?.status === 'active' ? { 'protection.autoConfirmAt': autoConfirmOf(now, o.protection.mode ?? o.mode ?? 'ecommerce') } : {}) },
            $push: { history: { status: 'delivered', at: now, note: 'Entregue (rastreio)' } },
          });
          out.delivered++;
        }
        if (r.status === 'canceled') await this.orders.updateOne({ _id: o._id, enterpriseId: o.enterpriseId }, { $set: { 'label.status': 'canceled' } });
      }
    }
    return out;
  }
}
