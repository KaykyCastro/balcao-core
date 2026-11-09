import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DisputeDto } from './dto/order.dto';
import { ProtectionService } from './protection.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { isMember } from '../customer/membership.rules';
import { Public } from '../common/decorators/public.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { CurrentShopper, ShopperGuard } from '../shopper/shopper.guard';
import type { ShopperDocument } from '../shopper/schema/shopper.schema';
import { CustomerService } from '../customer/customer.service';
import { SaleService } from '../sale/sale.service';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { Order } from './schema/order.schema';
import { Store } from './schema/store.schema';
import { OrderService } from './order.service';
import { crossTenant } from '../common/security/tenant-guard.plugin';

class JoinDto {
  @IsOptional() @IsString() @MaxLength(200) message?: string;
}

class ShopperOrdersQueryDto {
  @IsOptional() @IsString() @Matches(/^[a-z0-9-]{2,60}$/) store?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}

const METHOD: Record<string, string> = { cash: 'Dinheiro', pix: 'Pix', card: 'Cartão', other: 'Outro', fiado: 'Fiado', online: 'Loja online' };

/**
 * "Minha conta" do comprador: pedidos em todas as lojas, lojas onde é cliente e débitos (fiado) em cada uma.
 * Tudo filtrado pela conta logada; o comprador nunca vê dados de outra pessoa.
 */
@Public()
@UseGuards(ShopperGuard)
@Controller('public/shopper')
export class ShopperAccountController {
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Store.name) private readonly stores: Model<Store>,
    private readonly orderService: OrderService,
    private readonly customers: CustomerService,
    private readonly sales: SaleService,
    private readonly enterprises: EnterpriseService,
    private readonly protection: ProtectionService,
  ) {
    this.orders = crossTenant(orders, 'conta do comprador: toda consulta filtra pelo shopperId dele');
    this.stores = crossTenant(stores, 'vitrine: loja ligada por slug, só dados públicos');
  }

  private async storeCards(enterpriseIds: Types.ObjectId[]) {
    const ids = [...new Set(enterpriseIds.map(String))];
    const [stores, ents] = await Promise.all([
      this.stores.find({ enterpriseId: { $in: ids } }).select('enterpriseId slug name logo enabled theme.accent').lean(),
      Promise.all(ids.map((id) => this.enterprises.findEnterpriseById(id).catch(() => null))),
    ]);
    const map = new Map<string, { slug: string | null; name: string; logo: string; accent: string; online: boolean }>();
    ids.forEach((id, k) => {
      const st = stores.find((s) => String(s.enterpriseId) === id);
      const e = ents[k] as { name?: string; logo?: string } | null;
      map.set(id, { slug: st?.slug ?? null, name: st?.name || e?.name || 'Loja', logo: st?.logo || e?.logo || '', accent: st?.theme?.accent ?? '', online: !!st?.enabled });
    });
    return map;
  }

  /** Cópia dos dados da conta (LGPD, art. 18, II e V): perfil, endereços, lojas onde é cliente e pedidos. */
  @Get('export')
  async export(@CurrentShopper() s: ShopperDocument) {
    const [orders, customers] = await Promise.all([
      this.orders.find({ shopperId: s._id }).sort({ createdAt: -1 }).limit(1000),
      this.customers.forShopper(s._id),
    ]);
    const cards = await this.storeCards([...orders.map((o) => o.enterpriseId), ...customers.map((c) => c.enterpriseId)]);
    return {
      geradoEm: new Date().toISOString(),
      conta: { nome: s.name, email: s.email, telefone: s.phone, documento: s.document, emailConfirmado: !!s.emailVerifiedAt, criadaEm: (s as any).createdAt ?? null, aceites: s.consents ?? null },
      enderecos: s.addresses ?? [],
      lojas: customers.map((c) => ({ loja: cards.get(String(c.enterpriseId))?.name ?? '', clienteDaLoja: isMember(c), clienteDesde: c.memberSince ?? null, nomeNoCadastro: c.name, telefone: c.numberWithPrefix, endereco: c.address, saldoDevedorCentavos: c.debitCents ?? 0 })),
      pedidos: orders.map((o) => ({
        loja: cards.get(String(o.enterpriseId))?.name ?? '', numero: o.number, data: (o as any).createdAt, status: o.status, totalCentavos: o.totalCents,
        itens: o.items.map((i) => ({ produto: i.productName, quantidade: i.quantity, totalCentavos: i.totalCents })),
        entrega: o.shipping?.name, endereco: o.address, contato: o.customer,
      })),
    };
  }

  @Get('orders')
  async list(@CurrentShopper() s: ShopperDocument, @Query() q: ShopperOrdersQueryDto) {
    const filter: Record<string, unknown> = { shopperId: s._id, status: { $ne: 'expired' } };
    if (q.store) filter.storeSlug = q.store;
    const [rows, total] = await Promise.all([
      this.orders.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.orders.countDocuments(filter),
    ]);
    const cards = await this.storeCards(rows.map((o) => o.enterpriseId));
    return { items: rows.map((o) => ({ ...this.orderService.present(o as any, true), store: cards.get(String(o.enterpriseId)) })), total, page: q.page, limit: q.limit };
  }

  @Get('orders/:id')
  async one(@CurrentShopper() s: ShopperDocument, @Param('id', ParseMongoIdPipe) id: string) {
    const o = await this.orders.findOne({ _id: id, shopperId: s._id });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    const cards = await this.storeCards([o.enterpriseId]);
    return { ...this.orderService.present(o as any, true), store: cards.get(String(o.enterpriseId)) };
  }

  @Post('orders/:id/received') @HttpCode(200)
  async received(@CurrentShopper() s: ShopperDocument, @Param('id', ParseMongoIdPipe) id: string) {
    const o = await this.orders.findOne({ _id: id, shopperId: s._id });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    return this.protection.received(o as any, 'cliente');
  }

  @Post('orders/:id/dispute') @HttpCode(200)
  async dispute(@CurrentShopper() s: ShopperDocument, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: DisputeDto) {
    const o = await this.orders.findOne({ _id: id, shopperId: s._id });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    return this.protection.openDispute(o as any, dto.reason, dto.message);
  }

  // ---------------------------------------------------------------- pertencer à loja

  private async storeBySlug(slug: string) {
    const st = await this.stores.findOne({ slug, enabled: true }).select('enterpriseId').lean();
    if (!st) throw new NotFoundException('Loja não encontrada');
    return st;
  }

  /** Situação nesta loja: já é cliente, pediu, foi convidado ou nada (para o botão "Quero ser cliente"). */
  @Get('membership/:slug')
  async membership(@CurrentShopper() s: ShopperDocument, @Param('slug') slug: string) {
    const st = await this.storeBySlug(slug);
    const c = await this.customers.forShopperAt(s._id, st.enterpriseId);
    if (c && isMember(c)) return { status: 'member', customerId: String(c._id), debitCents: c.debitCents ?? 0 };
    const open = (await this.customers.pendingOfShopper(s._id)).find((r) => String(r.enterpriseId) === String(st.enterpriseId));
    return { status: open ? (open.direction === 'invite' ? 'invited' : 'pending') : 'none', requestId: open ? String(open._id) : null, verified: !!s.emailVerifiedAt };
  }

  /** Pede para ser cliente da loja (a loja aceita ou recusa; precisa do e-mail confirmado). */
  @Post('membership/:slug') @HttpCode(200)
  async join(@CurrentShopper() s: ShopperDocument, @Param('slug') slug: string, @Body() dto: JoinDto) {
    const st = await this.storeBySlug(slug);
    return this.customers.requestJoin(s._id, String(st.enterpriseId), dto.message);
  }

  /** Convites das lojas e pedidos feitos, ainda sem resposta. */
  @Get('memberships')
  async memberships(@CurrentShopper() s: ShopperDocument) {
    const rows = await this.customers.pendingOfShopper(s._id);
    const cards = await this.storeCards(rows.map((r) => r.enterpriseId));
    return { items: rows.map((r) => ({ id: String(r._id), direction: r.direction, at: (r as any).createdAt, store: cards.get(String(r.enterpriseId)) })) };
  }

  @Post('memberships/:id/accept') @HttpCode(200)
  async acceptInvite(@CurrentShopper() s: ShopperDocument, @Param('id', ParseMongoIdPipe) id: string) {
    await this.customers.shopperAnswer(s._id, id, 'accept');
    return { ok: true };
  }

  /** Recusa o convite ou desiste do pedido. */
  @Post('memberships/:id/decline') @HttpCode(204)
  async declineInvite(@CurrentShopper() s: ShopperDocument, @Param('id', ParseMongoIdPipe) id: string) {
    await this.customers.shopperAnswer(s._id, id, 'decline');
  }

  /** QR de convite de um cadastro: de qual loja é (sem dados do cadastro). */
  @Get('invite/:token')
  async invitePreview(@CurrentShopper() s: ShopperDocument, @Param('token') token: string) {
    const p = await this.customers.previewCode(token);
    const cards = await this.storeCards([p.enterpriseId]);
    const c = await this.customers.forShopperAt(s._id, p.enterpriseId);
    return { store: cards.get(String(p.enterpriseId)), expiresAt: p.expiresAt, alreadyMember: !!c && isMember(c), verified: !!s.emailVerifiedAt };
  }

  @Post('invite/:token/accept') @HttpCode(200)
  async inviteAccept(@CurrentShopper() s: ShopperDocument, @Param('token') token: string) {
    const c = await this.customers.redeemCode(s._id, token);
    const cards = await this.storeCards([c.enterpriseId]);
    return { ok: true, store: cards.get(String(c.enterpriseId)) };
  }

  /** Sai da loja: só com o saldo quitado (409 DEBT_OPEN). */
  @Post('stores/:id/leave') @HttpCode(204)
  async leave(@CurrentShopper() s: ShopperDocument, @Param('id', ParseMongoIdPipe) id: string) {
    await this.customers.leave(s._id, id);
  }

  /** Lojas onde a conta é cliente, com o saldo de fiado em cada uma. */
  @Get('stores')
  async storesList(@CurrentShopper() s: ShopperDocument) {
    const list = await this.customers.forShopper(s._id);
    if (!list.length) return { items: [], totalDebitCents: 0 };
    const cards = await this.storeCards(list.map((c) => c.enterpriseId));
    const counts = await this.orders.aggregate<{ _id: Types.ObjectId; n: number; last: Date }>([
      { $match: { shopperId: s._id, status: { $nin: ['expired'] } } },
      { $group: { _id: '$enterpriseId', n: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]);
    const items = list.map((c) => {
      const k = counts.find((x) => String(x._id) === String(c.enterpriseId));
      return { id: String(c._id), ...cards.get(String(c.enterpriseId))!, debitCents: c.debitCents ?? 0, member: isMember(c), memberSince: c.memberSince ?? null, since: (c as any).createdAt, orders: k?.n ?? 0, lastOrderAt: k?.last ?? null };
    }).sort((a, b) => b.debitCents - a.debitCents || String(b.lastOrderAt ?? '').localeCompare(String(a.lastOrderAt ?? '')));
    return { items, totalDebitCents: items.reduce((t, i) => t + i.debitCents, 0) };
  }

  /** Extrato numa loja: saldo devedor, compras (balcão e online) e pagamentos do fiado. */
  @Get('stores/:id')
  async storeDetail(@CurrentShopper() s: ShopperDocument, @Param('id', ParseMongoIdPipe) id: string) {
    const all = await this.customers.forShopper(s._id);
    const c = all.find((x) => String(x._id) === id);
    if (!c) throw new NotFoundException('Loja não encontrada na sua conta');
    const [cards, sales, payments] = await Promise.all([
      this.storeCards([c.enterpriseId]),
      this.sales.forCustomer(c.enterpriseId, c._id),
      this.customers.paymentsOf(c.enterpriseId, c._id),
    ]);
    return {
      id: String(c._id), ...cards.get(String(c.enterpriseId))!, debitCents: c.debitCents ?? 0, customerName: c.name, member: isMember(c),
      purchases: sales.map((x) => ({
        id: String(x._id), at: (x as any).createdAt, totalCents: x.totalCents, method: x.paymentMethod, methodLabel: METHOD[x.paymentMethod] ?? x.paymentMethod,
        channel: x.channel ?? 'pos', orderId: x.orderId ? String(x.orderId) : null,
        items: (x.items ?? []).map((i) => ({ name: i.productName, quantity: i.quantity, totalCents: i.totalCents })),
      })),
      payments: payments.map((p) => ({ id: String(p._id), at: (p as any).createdAt, amountCents: p.amountCents, method: p.method, methodLabel: METHOD[p.method] ?? p.method })),
    };
  }
}
