import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schema/order.schema';
import { OrderService } from './order.service';
import { StoreService } from './store.service';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { MailService } from '../mail/mail.service';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { BillingService } from '../billing/billing.service';
import { open as openSealed } from '../common/secret-box';
import { autoConfirmOf, DISPUTE_REASONS, disputeBlock, graceEnd, PROTECTION, type DisputeReason } from './protection';
import { crossTenant } from '../common/security/tenant-guard.plugin';

const DAY = 86_400_000;
const fmt = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDay = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * Compra protegida: prazos de envio, confirmação de recebimento, reclamação e reembolso.
 * O dinheiro volta pelo Mercado Pago (estorno na conta do lojista). Quem decide reclamação sem acordo é a equipe do Balcão.
 */
@Injectable()
export class ProtectionService {
  private readonly logger = new Logger(ProtectionService.name);
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    private readonly orderService: OrderService,
    private readonly stores: StoreService,
    private readonly mp: MercadoPagoClient,
    private readonly mail: MailService,
    private readonly enterprises: EnterpriseService,
    private readonly billing: BillingService,
  ) {}

  private async ownerEmail(o: OrderDocument) { return (await this.enterprises.findEnterpriseById(String(o.enterpriseId)).catch(() => null))?.email ?? ''; }
  private async trackLink(o: OrderDocument) { return openSealed((await this.orders.findById(o._id).select('+linkSealed').lean())?.linkSealed) ?? ''; }

  // ------------------------------------------------------------------ comprador

  /** "Recebi meu pedido": encerra a proteção (e marca como entregue, se a loja ainda não marcou). */
  async received(o: OrderDocument, who: string) {
    if (!['shipped', 'ready_for_pickup', 'delivered'].includes(o.status)) throw new ConflictException('Dá para confirmar o recebimento depois que a loja enviar o pedido.');
    if (o.dispute?.status === 'open') throw new ConflictException('Há uma reclamação aberta. Para encerrar, responda à loja ou aguarde a decisão.');
    const now = new Date();
    const set: Record<string, unknown> = { 'protection.status': 'confirmed', 'protection.confirmedAt': now, 'protection.confirmedBy': who };
    const update: Record<string, unknown> = { $set: set };
    if (o.status !== 'delivered') { set.status = 'delivered'; update.$push = { history: { status: 'delivered', at: now, note: 'Recebimento confirmado pelo cliente' } }; }
    await this.orders.updateOne({ _id: o._id, status: o.status }, update);
    return this.orderService.present((await this.orders.findById(o._id))!, true);
  }

  async openDispute(o: OrderDocument, reason: DisputeReason, message: string) {
    const block = disputeBlock(o, reason);
    if (block) throw new UnprocessableEntityException(block);
    const now = new Date();
    const r = await this.orders.findOneAndUpdate(
      { _id: o._id, 'dispute.status': { $ne: 'open' } },
      { $set: { dispute: { status: 'open', reason, message: message.trim(), openedAt: now }, 'protection.status': 'disputed', seen: false }, $push: { history: { status: o.status, at: now, note: `Reclamação: ${DISPUTE_REASONS[reason]}` } } },
      { new: true },
    );
    if (!r) throw new ConflictException('Já existe uma reclamação aberta para este pedido.');
    const owner = await this.ownerEmail(o);
    if (owner) void this.mail.send(owner, `Reclamação no pedido #${o.number}: ${DISPUTE_REASONS[reason]}`, `O cliente ${o.customer.name} abriu uma reclamação no pedido #${o.number}.\n\nMotivo: ${DISPUTE_REASONS[reason]}\n"${message.trim()}"\n\nResponda em até ${PROTECTION.replyDays} dias em Loja online → Pedidos. Sem resposta, a equipe do Balcão decide e pode devolver o dinheiro ao cliente.`).catch(() => undefined);
    void this.mail.send(o.customer.email, `Recebemos sua reclamação - pedido #${o.number}`, `Sua reclamação foi enviada à loja. Ela tem ${PROTECTION.replyDays} dias para responder; se não houver acordo, a equipe do Balcão analisa e decide.\n\nAcompanhe pelo link do pedido: ${await this.trackLink(o)}`).catch(() => undefined);
    return this.orderService.present(r, true);
  }

  // ------------------------------------------------------------------ lojista

  private async mine(eid: string, id: string) {
    const o = await this.orders.findOne({ _id: id, enterpriseId: new Types.ObjectId(eid) });
    if (!o) throw new NotFoundException('Pedido não encontrado');
    return o;
  }

  async reply(eid: string, id: string, message: string) {
    const o = await this.mine(eid, id);
    if (o.dispute?.status !== 'open') throw new ConflictException('Não há reclamação aberta neste pedido.');
    await this.orders.updateOne({ _id: o._id }, { $set: { 'dispute.sellerReply': message.trim(), 'dispute.sellerRepliedAt': new Date(), seen: true } });
    void this.mail.send(o.customer.email, `A loja respondeu sua reclamação - pedido #${o.number}`, `"${message.trim()}"\n\nVeja no seu pedido: ${await this.trackLink(o)}`).catch(() => undefined);
    return this.orderService.present((await this.orders.findById(o._id))!);
  }

  /** Lojista aceita devolver o dinheiro (desistência, defeito, não entregue). */
  async refundBySeller(eid: string, id: string, reason: string) { return this.orderService.present(await this.refund(await this.mine(eid, id), reason, 'loja')); }

  // ------------------------------------------------------------------ reembolso

  /**
   * Devolve o dinheiro ao comprador. Antes de entregar: é o cancelamento normal (repõe o estoque).
   * Depois de entregue: estorna no Mercado Pago e desfaz a taxa, sem mexer no estoque (o produto pode não voltar).
   */
  async refund(o: OrderDocument, reason: string, by: string): Promise<OrderDocument> {
    const resolved = { 'dispute.status': 'resolved_refund', 'dispute.resolvedAt': new Date(), 'dispute.resolvedBy': by, 'dispute.note': reason };
    if (['paid', 'preparing', 'ready_for_pickup', 'shipped'].includes(o.status)) {
      await this.orderService.cancel(String(o.enterpriseId), String(o._id), { reason });
      const after = (await this.orders.findById(o._id))!;
      await this.orders.updateOne({ _id: o._id }, { $set: { 'protection.status': after.payment?.refundedAt ? 'refunded' : after.protection?.status ?? 'active', ...(o.dispute?.status === 'open' ? resolved : {}) } });
      return (await this.orders.findById(o._id))!;
    }
    if (o.status !== 'delivered') throw new ConflictException('Este pedido não está pago.');
    if (o.payment?.refundedAt) throw new ConflictException('Este pedido já foi reembolsado.');
    if (!o.payment?.paymentId) throw new ConflictException('Pagamento não encontrado no Mercado Pago. Devolva direto ao cliente.');
    try {
      await this.mp.refund(o.payment.paymentId, await this.stores.mpAccessToken(o.storeId), `refund-${o._id}`);
    } catch (e) {
      this.logger.warn(`Reembolso do pedido ${o._id} falhou: ${(e as Error).message}`);
      throw new UnprocessableEntityException('O Mercado Pago não conseguiu devolver agora (saldo da loja insuficiente ou pagamento antigo). Devolva direto ao cliente e marque como resolvido.');
    }
    const now = new Date();
    await this.orders.updateOne({ _id: o._id }, {
      $set: { 'payment.refundedAt': now, refundNeeded: false, feeCents: 0, 'protection.status': 'refunded', ...(o.dispute?.status === 'open' ? resolved : {}) },
      $push: { history: { status: 'delivered', at: now, note: `Reembolsado: ${reason}` } },
    });
    if (o.saleId) await this.billing.reverseCollectedFee(o.saleId).catch(() => undefined);
    void this.mail.send(o.customer.email, `Reembolso do pedido #${o.number}`, `Devolvemos ${fmt(o.totalCents)} pelo Mercado Pago, no mesmo meio de pagamento.\nPix: em até 1 dia útil. Cartão: na fatura, conforme o banco (até 2 faturas).`).catch(() => undefined);
    return (await this.orders.findById(o._id))!;
  }

  // ------------------------------------------------------------------ equipe do Balcão

  async listDisputes(q: { status?: 'open' | 'escalated' | 'resolved'; page: number; limit: number }) {
    const filter: Record<string, unknown> = q.status === 'resolved' ? { 'dispute.status': { $in: ['resolved_refund', 'resolved_seller'] } } : { 'dispute.status': 'open', ...(q.status === 'escalated' ? { 'dispute.escalatedAt': { $ne: null } } : {}) };
    const [rows, total] = await Promise.all([
      crossTenant(this.orders, 'equipe do Balcão: reclamações de todas as lojas').find(filter).sort({ 'dispute.openedAt': -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      crossTenant(this.orders, 'equipe do Balcão: reclamações de todas as lojas').countDocuments(filter),
    ]);
    return { items: rows.map((o) => ({ ...this.orderService.present(o), storeSlug: o.storeSlug, enterpriseId: String(o.enterpriseId) })), total, page: q.page, limit: q.limit };
  }

  async resolve(id: string, decision: 'refund' | 'seller', actor: string, note: string) {
    const o = await this.orders.findById(id);
    if (!o) throw new NotFoundException('Pedido não encontrado');
    if (o.dispute?.status !== 'open') throw new BadRequestException('Esta reclamação já foi resolvida.');
    if (decision === 'refund') return this.orderService.present(await this.refund(o, note || 'Decisão da equipe do Balcão', `admin:${actor}`));
    await this.orders.updateOne({ _id: o._id }, { $set: { 'dispute.status': 'resolved_seller', 'dispute.resolvedAt': new Date(), 'dispute.resolvedBy': `admin:${actor}`, 'dispute.note': note, 'protection.status': 'confirmed', 'protection.confirmedAt': new Date(), 'protection.confirmedBy': 'decisão' } });
    void this.mail.send(o.customer.email, `Reclamação do pedido #${o.number} encerrada`, `Analisamos sua reclamação e ela foi encerrada a favor da loja.${note ? `\n\nMotivo: ${note}` : ''}\n\nSe discordar, você ainda pode abrir uma disputa no Mercado Pago ou procurar o consumidor.gov.br.`).catch(() => undefined);
    return this.orderService.present((await this.orders.findById(o._id))!);
  }

  // ------------------------------------------------------------------ rotina

  /** De hora em hora: avisa prazo de envio, cancela o que passou do prazo, confirma entregues sem queixa e sobe reclamações paradas. */
  async tick(now = new Date()) {
    const out = { warned: 0, cancelled: 0, confirmed: 0, escalated: 0 };
    const waiting: Record<string, unknown> = { status: { $in: ['paid', 'preparing'] }, 'shipping.kind': { $ne: 'table' }, 'protection.status': { $in: ['active', 'disputed'] } };

    // Aviso 12 h antes do prazo.
    for (const o of await crossTenant(this.orders, 'rotina: proteção da compra em todas as lojas').find({ ...waiting, 'protection.mode': { $ne: 'menu' }, 'protection.warnedAt': null, 'protection.shipBy': { $lte: new Date(now.getTime() + 12 * 3600_000) } }).limit(200)) {
      const email = await this.ownerEmail(o);
      if (email) await this.mail.send(email, `Prazo de envio do pedido #${o.number} acabando`, `O pedido #${o.number} (${o.customer.name}, ${fmt(o.totalCents)}) precisa ser ${o.shipping.kind === 'pickup' ? 'marcado como pronto para retirada' : 'enviado'} até ${fmtDay(o.protection!.shipBy!)}.\n\nSe passar de ${fmtDay(o.protection!.graceAt ?? graceEnd(o.protection!.shipBy!, o.protection!.mode ?? 'ecommerce'))}, a Compra protegida cancela o pedido e devolve o dinheiro ao cliente.`).catch(() => undefined);
      await this.orders.updateOne({ _id: o._id, enterpriseId: o.enterpriseId }, { $set: { 'protection.warnedAt': now } });
      out.warned++;
    }
    // Passou do prazo + tolerância sem enviar: cancela e devolve.
    // (pedidos antigos sem graceAt: prazo de e-commerce)
    for (const o of await crossTenant(this.orders, 'rotina: proteção da compra em todas as lojas').find({ ...waiting, $or: [{ 'protection.graceAt': { $lte: now } }, { 'protection.graceAt': null, 'protection.shipBy': { $lte: new Date(now.getTime() - PROTECTION.graceDays * DAY) } }] }).limit(100)) {
      try {
        await this.refund(o, 'Prazo de envio esgotado (Compra protegida)', 'sistema');
        out.cancelled++;
      } catch (e) { this.logger.warn(`Cancelamento por prazo do pedido ${o._id} falhou: ${(e as Error).message}`); }
    }
    // Entregue há mais de 7 dias sem reclamação: recebido.
    const r = await crossTenant(this.orders, 'rotina: proteção da compra em todas as lojas').updateMany({ status: 'delivered', 'protection.status': 'active', 'protection.autoConfirmAt': { $lte: now } }, { $set: { 'protection.status': 'confirmed', 'protection.confirmedAt': now, 'protection.confirmedBy': 'prazo' } });
    out.confirmed = r.modifiedCount ?? 0;
    // Reclamação sem resposta da loja: sobe para a equipe.
    const e = await crossTenant(this.orders, 'rotina: proteção da compra em todas as lojas').updateMany({ 'dispute.status': 'open', 'dispute.escalatedAt': null, 'dispute.sellerRepliedAt': null, 'dispute.openedAt': { $lte: new Date(now.getTime() - PROTECTION.replyDays * DAY) } }, { $set: { 'dispute.escalatedAt': now } });
    out.escalated = e.modifiedCount ?? 0;
    return out;
  }

  /** Ao marcar como entregue: começa a contar o prazo de reclamação. */
  static deliveredSet(now: Date) { return { 'protection.autoConfirmAt': autoConfirmOf(now) }; }
}
