import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { MpPollService } from './mp-poll.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AutopayService } from '../billing/autopay.service';
import { BillingService } from '../billing/billing.service';
import { MessagesService } from '../messages/messages.service';
import { crossTenant } from '../common/security/tenant-guard.plugin';
import { MercadoPagoClient, isOrderId } from '../mercadopago/mercadopago.client';
import { Order } from './schema/order.schema';
import { Store } from './schema/store.schema';
import { Tab } from './schema/tab.schema';
import { OrderService } from './order.service';
import { StoreService } from './store.service';
import { TabService } from './tab.service';

/**
 * Webhook único das ordens de Checkout Pro (API de Orders). Na API de Orders os avisos não vão por cobrança: chegam todos
 * no endereço cadastrado no painel da aplicação (evento "Order"), inclusive os das contas dos lojistas conectados.
 *
 * Nada do aviso é confiado: confere a assinatura (MP_WEBHOOK_SECRET), descobre a conta pelo `user_id`, consulta a ordem
 * no Mercado Pago com o token DESSA conta e só então chama a mesma confirmação de sempre (referência, conta, valor):
 * - conta do Balcão → fatura do sistema;
 * - conta de um lojista → pedido da loja online ou comanda da mesa (pela referência, dentro daquela loja).
 * Avisos de assinatura (cobrança automática das faturas) seguem para o AutopayService.
 */
@Injectable()
export class MpOrdersWebhookService {
  private readonly logger = new Logger('WebhookOrdens');
  private platformUser: Promise<string> | null = null;

  constructor(
    private readonly mp: MercadoPagoClient,
    private readonly billing: BillingService,
    private readonly autopay: AutopayService,
    private readonly orders: OrderService,
    private readonly tabs: TabService,
    private readonly stores: StoreService,
    private readonly messages: MessagesService,
    @InjectModel(Store.name) storeModel: Model<Store>,
    @InjectModel(Order.name) orderModel: Model<Order>,
    @InjectModel(Tab.name) tabModel: Model<Tab>,
    private readonly polls?: MpPollService,
  ) {
    this.storeModel = crossTenant(storeModel, 'webhook de ordens: achar a loja pela conta do Mercado Pago (user_id)');
    this.orderModel = crossTenant(orderModel, 'webhook de ordens: pedido pela referência, conferido contra a loja da conta');
    this.tabModel = crossTenant(tabModel, 'webhook de ordens: comanda pela referência, conferida contra a loja da conta');
  }
  private readonly storeModel: Model<Store>;
  private readonly orderModel: Model<Order>;
  private readonly tabModel: Model<Tab>;

  /** Conta do Balcão no Mercado Pago (dona das faturas do sistema). */
  private platformUserId() {
    this.platformUser ??= this.mp.me(this.mp.platformToken).then((m) => m.id).catch((e) => { this.platformUser = null; throw e; });
    return this.platformUser;
  }

  /**
   * Vinculação OAuth (tópico mp-connect): quando o lojista tira a permissão do Balcão pelo próprio Mercado Pago
   * (application.deauthorized), a loja é desconectada na hora (e desligada, como em "Desconectar") e o lojista é avisado.
   * A vinculação (application.authorized) só fica registrada: quem conclui a conexão é a volta do OAuth.
   */
  private async connect(body: Record<string, any>, headers: { signature?: string; requestId?: string }) {
    const userId = String(body?.user_id ?? body?.data?.id ?? '');
    if (!/^\d{1,20}$/.test(userId)) return { received: true, outcome: 'ignored' };
    if (!this.mp.verifySignature(String(body?.data?.id ?? userId), headers.requestId, headers.signature)) throw new UnauthorizedException('Assinatura inválida');
    if (body?.action !== 'application.deauthorized') return { received: true, outcome: 'noted' };
    const store = await this.storeModel.findOne({ 'mp.userId': userId }).select('_id enterpriseId').lean();
    if (!store) return { received: true, outcome: 'store_not_found' };
    await this.stores.mpDisconnect(String(store.enterpriseId));
    await this.messages.notify(store.enterpriseId as never, {
      title: 'Mercado Pago desconectado', level: 'warning', link: '/app/loja?aba=pagamento',
      body: 'A permissão do Balcão foi retirada na sua conta do Mercado Pago, então a loja online foi desligada para não aceitar pedidos que não teriam como ser pagos. Para voltar a vender, conecte o Mercado Pago de novo em Loja online → Pagamento.',
    }).catch(() => undefined);
    this.logger.log(`Conta ${userId} retirou a permissão: loja ${String(store.enterpriseId)} desconectada`);
    return { received: true, outcome: 'disconnected' };
  }

  /**
   * Contestação (chargeback) aberta pelo comprador no banco. O Balcão não responde por ninguém: avisa quem recebeu
   * (lojista no sino; plataforma no log de erro) para responder no painel do Mercado Pago dentro do prazo.
   */
  private async chargeback(body: Record<string, any>, q: Record<string, unknown>, headers: { signature?: string; requestId?: string }) {
    const id = String(body?.data?.id ?? q['data.id'] ?? q.id ?? '');
    if (!/^[\w-]{1,64}$/.test(id)) return { received: true, outcome: 'ignored' };
    if (!this.mp.verifySignature(id, headers.requestId, headers.signature)) throw new UnauthorizedException('Assinatura inválida');
    const userId = String(body?.user_id ?? '');
    if (userId && userId === (await this.platformUserId().catch(() => ''))) {
      this.logger.error(`Contestação ${id} na conta do Balcão (fatura): responder no painel do Mercado Pago`);
      return { received: true, outcome: 'platform_chargeback' };
    }
    const store = /^\d{1,20}$/.test(userId) ? await this.storeModel.findOne({ 'mp.userId': userId }).select('_id enterpriseId').lean() : null;
    if (!store) return { received: true, outcome: 'store_not_found' };
    await this.messages.notify(store.enterpriseId as never, {
      title: 'Contestação de pagamento no Mercado Pago', level: 'warning', link: '/app/loja?aba=pedidos',
      body: `Um comprador contestou um pagamento no banco ou no cartão (contestação ${id}). Entre no Mercado Pago, em Atividade → Contestações, e envie os comprovantes da venda e da entrega dentro do prazo indicado lá.`,
    }).catch(() => undefined);
    this.logger.warn(`Contestação ${id} (conta ${userId}): lojista ${String(store.enterpriseId)} avisado`);
    return { received: true, outcome: 'chargeback_notified' };
  }

  /** Recebe qualquer aviso do painel e registra no log o tipo, a ação, a conta e o resultado (sem dado pessoal). */
  async handle(q: Record<string, unknown>, body: Record<string, any>, headers: { signature?: string; requestId?: string }) {
    const tag = `Aviso do Mercado Pago ${String(body?.type ?? q.type ?? q.topic ?? '?')}/${String(body?.action ?? '-')} (conta ${String(body?.user_id ?? '?')}, id ${String(body?.data?.id ?? q['data.id'] ?? '?').slice(0, 40)})`;
    try {
      const r = await this.route(q, body, headers);
      this.logger.log(`${tag}: ${(r as { outcome?: string }).outcome ?? 'ok'}`);
      return r;
    } catch (e) {
      this.logger.warn(`${tag}: ${(e as Error).message}`);
      throw e;
    }
  }

  private async route(q: Record<string, unknown>, body: Record<string, any>, headers: { signature?: string; requestId?: string }) {
    const type = String(body?.type ?? q.type ?? q.topic ?? '');
    // O painel tem um endereço só por aplicação: os avisos da assinatura no cartão (cobrança automática das faturas)
    // também chegam aqui e seguem para o mesmo tratamento de antes.
    if (type === 'subscription_preapproval' || type === 'subscription_authorized_payment') return this.autopay.webhook(q, body, headers);
    if (type === 'mp-connect') return this.connect(body, headers);
    if (type === 'topic_chargebacks_wh' || type === 'chargebacks') return this.chargeback(body, q, headers);
    const id = String(body?.data?.id ?? q['data.id'] ?? '');
    // Ordem (ORD…) ou pagamento (número): os dois passam pelas mesmas conferências (a conta que recebeu, a referência,
    // o valor). Com o painel inscrito só em "Pagamentos", a baixa acontece do mesmo jeito.
    const ok = (type === 'order' && isOrderId(id)) || (type === 'payment' && /^\d{1,20}$/.test(id));
    if (!ok) return { received: true, outcome: 'ignored' };
    if (!this.mp.verifySignature(id, headers.requestId, headers.signature)) throw new UnauthorizedException('Assinatura inválida');
    const userId = String(body?.user_id ?? '');
    if (!/^\d{1,20}$/.test(userId)) return { received: true, outcome: 'no_account' };

    let outcome: string;
    if (userId === (await this.platformUserId())) {
      const pay = await this.mp.payment(id, this.mp.platformToken);
      outcome = pay.externalReference && /^[a-f0-9]{24}$/i.test(pay.externalReference) ? await this.billing.confirm(pay.externalReference, id) : 'no_reference';
    } else {
      const store = await this.storeModel.findOne({ 'mp.userId': userId }).select('_id enterpriseId').lean();
      outcome = store ? await this.forStore(store, id) : 'store_not_found';
    }
    this.logger.log(`${type === 'order' ? 'Ordem' : 'Pagamento'} ${id} (conta ${userId}): ${outcome}`);
    return { received: true, outcome };
  }

  /**
   * Aviso de uma loja: consulta a ordem/pagamento com o token DELA e acha, pela referência, o pedido, a conta da mesa
   * ou a cobrança do caixa daquela loja. Cada um confirma do seu jeito idempotente (referência, conta, valor).
   * Cobrança acompanhada pela consulta automática e já em consulta agora: pula (quem está com a vez resolve).
   */
  private async forStore(store: { _id: unknown; enterpriseId: unknown }, id: string): Promise<string> {
    const pay = await this.mp.payment(id, await this.stores.mpAccessToken(store._id as never));
    const ref = pay.externalReference ?? '';
    const pos = /^balcao-([a-f0-9]{24})$/i.exec(ref);
    if (pos) {
      // Cobrança do caixa (Pix ou maquininha): o PosService confere a ordem de novo e fecha a venda (chave pos:<id>).
      const sync = this.posSync;
      if (!sync) return 'pos_unavailable';
      return this.lease('pos', pos[1], () => sync(String(store.enterpriseId), pos[1]));
    }
    if (!/^[a-f0-9]{24}$/i.test(ref)) return 'no_reference';
    const where = { _id: new Types.ObjectId(ref), enterpriseId: store.enterpriseId as Types.ObjectId };
    const order = await this.orderModel.findOne(where);
    if (order) return this.lease('order', ref, () => this.orders.syncPayment(order as never, id));
    const tab = await this.tabModel.findOne(where);
    return tab ? this.lease('tab', ref, () => this.tabs.syncPayment(tab as never, id)) : 'not_found';
  }
  /** O caixa (PosModule, que importa este módulo) se registra aqui: assim o aviso chega à cobrança sem ciclo de módulos. */
  private posSync: ((eid: string, id: string) => Promise<string>) | null = null;
  registerPos(fn: (eid: string, id: string) => Promise<string>) { this.posSync = fn; }

  private lease(kind: 'order' | 'tab' | 'pos', ref: string, fn: () => Promise<string>) {
    return this.polls ? this.polls.lease(kind, ref, fn) : fn();
  }

  /**
   * Endereço de avisos de UMA loja (modo token): o lojista cadastra no painel da aplicação dele no Mercado Pago a URL
   * assinada que o Balcão mostra (StoreService.mpWebhookUrl). Não temos o segredo da aplicação do lojista, então não
   * há x-signature para conferir: a segurança é a URL assinada + NUNCA confiar no corpo. O que vale é sempre a
   * consulta da ordem/pagamento com o token da loja; um aviso dizendo "approved" sem pagamento real não confirma nada.
   */
  async handleStore(storeId: string, q: Record<string, unknown>, body: Record<string, any>) {
    if (!StoreService.mpWebhookOk(storeId, q.s)) throw new UnauthorizedException('Endereço inválido');
    const type = String(body?.type ?? q.type ?? q.topic ?? '');
    const id = String(body?.data?.id ?? q['data.id'] ?? '');
    const ok = (type === 'order' && isOrderId(id)) || (type === 'payment' && /^\d{1,20}$/.test(id));
    if (!ok) return { received: true, outcome: 'ignored' };
    const store = await this.storeModel.findOne({ _id: new Types.ObjectId(storeId) }).select('_id enterpriseId mp.userId').lean();
    if (!store?.mp?.userId) return { received: true, outcome: 'store_not_connected' };
    // O aviso diz de qual conta é: se não for a desta loja, nem consulta (alguém colou a URL na aplicação errada).
    const userId = String(body?.user_id ?? '');
    if (userId && userId !== store.mp.userId) return { received: true, outcome: 'other_account' };
    let outcome: string;
    try { outcome = await this.forStore(store, id); }
    catch (e) { this.logger.warn(`Aviso da loja ${storeId} (${type} ${id.slice(0, 40)}): ${(e as Error).message}`); throw e; }
    this.logger.log(`Aviso da loja ${storeId} (${type} ${id.slice(0, 40)}): ${outcome}`);
    return { received: true, outcome };
  }
}
