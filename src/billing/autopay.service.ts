import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EnterpriseSchema } from '../enterprise/schema/enterprise.schema';
import { MercadoPagoClient, type MpPreapproval } from '../mercadopago/mercadopago.client';
import { SettingsService } from '../settings/settings.service';
import { BillingService } from './billing.service';
import { Invoice } from './schema/invoice.schema';
import { PaymentEvent } from './schema/payment-event.schema';
import { autopayAmount, nextChargeDate } from './autopay.rules';

export const autopayRef = (eid: string) => `balcao-autopay:${eid}`;

/**
 * Cobrança automática da fatura do sistema no cartão, por assinatura do Mercado Pago (preapproval).
 * - O lojista digita o cartão na página do Mercado Pago; o Balcão guarda só o id da assinatura e o estado.
 * - A cobrança é sempre no dia 3 (a fatura sai no dia 1 e vence 15 dias depois): quando a fatura sai, o valor do
 *   próximo ciclo vira o da fatura; mês sem fatura, a assinatura fica pausada.
 * - Pagamento só baixa a fatura depois de consultado no Mercado Pago (aprovado, da assinatura desta empresa).
 */
@Injectable()
export class AutopayService {
  private readonly log = new Logger('CobrancaAutomatica');
  constructor(
    @InjectModel(EnterpriseSchema.name) private readonly enterprises: Model<EnterpriseSchema>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(PaymentEvent.name) private readonly events: Model<PaymentEvent>,
    private readonly mp: MercadoPagoClient,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, ''); }

  private async save(eid: string | Types.ObjectId, pp: MpPreapproval) {
    await this.enterprises.updateOne({ _id: eid }, { $set: { autopay: { preapprovalId: pp.id, status: pp.status, amountCents: pp.amountCents || null, nextChargeAt: pp.nextPaymentDate, updatedAt: new Date() } } });
  }

  /** Sem MP_ACCESS_TOKEN (conta do Balcão no Mercado Pago), não há como criar a assinatura. */
  get available() { return !!this.config.get<string>('MP_ACCESS_TOKEN')?.trim(); }

  async status(eid: string) {
    const e = await this.enterprises.findById(eid).select('autopay').lean();
    const a = e?.autopay;
    return a && a.status !== 'cancelled' ? { status: a.status, amountCents: a.amountCents, nextChargeAt: a.nextChargeAt } : null;
  }

  /** Cria a assinatura e devolve o link do Mercado Pago para o lojista cadastrar o cartão lá. */
  async start(eid: string) {
    if (!this.available) throw new ConflictException({ code: 'AUTOPAY_UNAVAILABLE', message: 'O pagamento automático ainda não está disponível. Por enquanto, pague pelo link da fatura (Pix ou cartão).' });
    const e = await this.enterprises.findById(eid).select('email name autopay feeCapCents').lean();
    if (!e) throw new NotFoundException('Empresa não encontrada');
    if (e.autopay && ['authorized', 'paused'].includes(e.autopay.status)) throw new ConflictException({ code: 'AUTOPAY_ACTIVE', message: 'A cobrança automática já está ativa.' });
    if (e.autopay?.preapprovalId) await this.mp.updatePreapproval(e.autopay.preapprovalId, { status: 'cancelled' }).catch(() => undefined); // tentativa anterior não concluída
    const cap = e.feeCapCents ?? (await this.settings.policy()).capCents;
    const pp = await this.mp.createPreapproval({
      reason: 'Balcão ERP: fatura mensal de uso', externalReference: autopayRef(eid), payerEmail: e.email,
      amountCents: Math.max(100, cap), startDate: nextChargeDate(new Date()), backUrl: `${this.front}/app/pagamento?cartao=1`,
    });
    if (!/^https:\/\//.test(pp.initPoint)) throw new ConflictException('O Mercado Pago não devolveu o link para cadastrar o cartão.');
    await this.save(eid, pp);
    return { url: pp.initPoint };
  }

  /** Lê o estado da assinatura no Mercado Pago (volta do cadastro do cartão, webhook e rotina diária). */
  async sync(eid: string) {
    const e = await this.enterprises.findById(eid).select('autopay').lean();
    if (!e?.autopay?.preapprovalId) return null;
    const pp = await this.mp.getPreapproval(e.autopay.preapprovalId);
    if (pp.externalReference !== autopayRef(eid)) { this.log.warn(`Assinatura ${pp.id} não é de ${eid}`); return this.status(eid); }
    await this.save(eid, pp);
    if (pp.status === 'authorized') await this.reconcile(eid).catch((err: Error) => this.log.warn(`Conciliação de ${eid}: ${err.message}`));
    return this.status(eid);
  }

  async cancel(eid: string) {
    const e = await this.enterprises.findById(eid).select('autopay').lean();
    if (e?.autopay?.preapprovalId) await this.mp.updatePreapproval(e.autopay.preapprovalId, { status: 'cancelled' }).catch((err: Error) => this.log.warn(`Cancelar assinatura: ${err.message}`));
    await this.enterprises.updateOne({ _id: eid }, { $set: { autopay: null } });
    return null;
  }

  /** Depois do fechamento do mês: o próximo ciclo cobra o que está em aberto (ou pausa se não há nada). */
  async prepareAll(now = new Date()) {
    const list = await this.enterprises.find({ 'autopay.status': { $in: ['authorized', 'paused'] } }).select('autopay').lean();
    for (const e of list) {
      try {
        const pending = await this.invoices.find({ enterpriseId: e._id, status: 'pending', dueDate: { $gt: now } }).select('amountCents').lean();
        const want = autopayAmount(pending);
        const a = e.autopay!;
        if (want > 0 && (a.status !== 'authorized' || a.amountCents !== want)) await this.save(e._id, await this.mp.updatePreapproval(a.preapprovalId, { amountCents: want, status: 'authorized' }));
        else if (want === 0 && a.status === 'authorized') await this.save(e._id, await this.mp.updatePreapproval(a.preapprovalId, { status: 'paused' }));
      } catch (err) { this.log.error(`Preparar cobrança de ${e._id}: ${(err as Error).message}`); }
    }
  }

  /** Confere as cobranças da assinatura no Mercado Pago e baixa as faturas pagas (idempotente). */
  async reconcile(eid: string) {
    const e = await this.enterprises.findById(eid).select('autopay').lean();
    if (!e?.autopay?.preapprovalId) return 0;
    let applied = 0;
    for (const ap of await this.mp.authorizedPayments(e.autopay.preapprovalId)) {
      if (ap.paymentId) applied += await this.applyPayment(eid, ap.paymentId);
    }
    return applied;
  }

  async reconcileAll() {
    const ids = await this.enterprises.distinct('_id', { 'autopay.status': { $in: ['authorized', 'paused'] } });
    for (const id of ids) {
      const has = await this.invoices.exists({ enterpriseId: id as Types.ObjectId, status: 'pending' });
      if (has) await this.reconcile(String(id)).catch((err: Error) => this.log.error(`Conciliação de ${id}: ${err.message}`));
    }
  }

  /** Pagamento aprovado da assinatura: quita as faturas em aberto da mais antiga para a mais nova, até onde o valor cobre. */
  private async applyPayment(eid: string, paymentId: string): Promise<number> {
    if (await this.invoices.exists({ paymentId })) return 0;
    if (await this.events.exists({ paymentId, outcome: { $in: ['autopay_applied', 'autopay_unapplied'] } })) return 0;
    const pay = await this.mp.payment(paymentId, this.mp.platformToken);
    if (pay.status !== 'approved') return 0;
    let left = pay.amountCents; let n = 0;
    const pending = await this.invoices.find({ enterpriseId: eid, status: 'pending' }).sort({ dueDate: 1 });
    for (const inv of pending) {
      if (inv.amountCents > left) break;
      if (await this.billing.markPaid(inv._id, { via: 'mercadopago', paymentId: pay.id, method: pay.method ?? 'credit_card', paidAmountCents: inv.amountCents, note: 'Cobrança automática no cartão' })) { left -= inv.amountCents; n++; }
    }
    await this.events.create({ invoiceId: pending[0]?._id ?? null, paymentId, outcome: n ? 'autopay_applied' : 'autopay_unapplied', raw: { enterpriseId: eid, amountCents: pay.amountCents, invoices: n } }).catch(() => undefined);
    if (!n) this.log.warn(`Pagamento ${paymentId} da assinatura de ${eid} não cobriu nenhuma fatura em aberto`);
    return n;
  }

  /** Webhook das assinaturas (configurado no painel do Mercado Pago). Tudo é reconsultado na API. */
  async webhook(q: Record<string, unknown>, body: Record<string, any>, headers: { signature?: string; requestId?: string }) {
    const topic = String(body?.type ?? q.type ?? q.topic ?? '');
    const id = String(body?.data?.id ?? q['data.id'] ?? q.id ?? '');
    if (!/^[\w-]{1,64}$/.test(id)) return { received: true, outcome: 'ignored' };
    if (headers.signature && !this.mp.verifySignature(id, headers.requestId, headers.signature)) return { received: true, outcome: 'bad_signature' };
    if (topic === 'subscription_preapproval') {
      const e = await this.enterprises.findOne({ 'autopay.preapprovalId': id }).select('_id').lean();
      if (e) await this.sync(String(e._id));
      return { received: true, outcome: e ? 'synced' : 'unknown' };
    }
    if (topic === 'subscription_authorized_payment') {
      const ap = await this.mp.authorizedPayment(id);
      const e = await this.enterprises.findOne({ 'autopay.preapprovalId': ap.preapprovalId }).select('_id').lean();
      if (!e || !ap.paymentId) return { received: true, outcome: 'unknown' };
      return { received: true, outcome: (await this.applyPayment(String(e._id), ap.paymentId)) ? 'applied' : 'not_applied' };
    }
    return { received: true, outcome: 'ignored' };
  }
}
