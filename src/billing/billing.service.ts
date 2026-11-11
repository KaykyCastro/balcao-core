import { ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { EnterpriseService } from '../enterprise/enterprise.service';
import { FeeEntry } from './schema/fee-entry.schema';
import { Invoice, InvoiceDocument } from './schema/invoice.schema';
import { PaymentEvent } from './schema/payment-event.schema';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { sign, verifySigned } from '../common/secret-box';
import { FEE_RATE_BPS, calcFeeCents, graceDays } from './billing.constants';
import { SettingsService } from '../settings/settings.service';
import { dueDateFrom, feeWaived, freeMonthProblem, inTrial, isFreeMonth, trialDaysLeft, trialEnd } from './billing.rules';
import { nextMonthStart, periodOf } from '../common/period';
import { crossTenant } from '../common/security/tenant-guard.plugin';

export interface PaidInfo { via: 'mercadopago' | 'manual'; paymentId?: string; method?: string; paidAmountCents?: number; note?: string }

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectModel(FeeEntry.name) private readonly feeModel: Model<FeeEntry>,
    @InjectModel(Invoice.name) private readonly invoiceModel: Model<Invoice>,
    @InjectModel(PaymentEvent.name) private readonly eventModel: Model<PaymentEvent>,
    @InjectConnection() private readonly connection: Connection,
    private readonly enterpriseService: EnterpriseService,
    private readonly mp: MercadoPagoClient,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  /** Teto mensal desta empresa: o dela, se o admin definiu; senão o padrão da plataforma. */
  private async capFor(enterprise: { feeCapCents?: number | null }): Promise<number> {
    return enterprise.feeCapCents ?? (await this.settings.policy()).capCents;
  }

  // ------------------------------------------------------------------ taxa por venda

  /**
   * Cobra 0,5% da venda. Chamar DENTRO da transação da venda.
   * - Teste grátis (30 dias), empresa isenta ou admin: não cobra nada.
   * - Conta bloqueada por fatura vencida -> 402 BILLING_BLOCKED
   * - Teto de R$ 40 POR MÊS: a venda que cruza o teto cobra só o que falta; depois disso passa sem taxa.
   * Retorna a taxa efetivamente cobrada, em centavos.
   */
  async applyFee(enterpriseId: string, saleId: Types.ObjectId, saleTotalCents: number, session: ClientSession, opts: { allowBlocked?: boolean } = {}): Promise<number> {
    const enterprise = await this.enterpriseService.lockForBilling(enterpriseId, session);
    if (!enterprise) throw new NotFoundException('Empresa não encontrada');
    // Pedido online já pago pelo cliente: a venda precisa ser registrada mesmo que a conta tenha sido bloqueada no meio.
    if (enterprise.billing?.status === 'blocked' && !opts.allowBlocked) {
      throw this.paymentRequired('BILLING_BLOCKED', 'Conta bloqueada por fatura em aberto. Pague em /billing.');
    }
    if (feeWaived(enterprise)) return 0;

    const period = periodOf();
    if (isFreeMonth(enterprise, period)) return 0; // mês grátis dado pelo admin
    const soFar = await this.monthFeeCents(enterpriseId, period, session);
    const applied = Math.min(calcFeeCents(saleTotalCents), Math.max(0, (await this.capFor(enterprise)) - soFar));
    if (applied > 0) {
      await this.enterpriseService.addDebt(enterpriseId, applied, session);
      await this.feeModel.create([{ enterpriseId, saleId, baseCents: saleTotalCents, rateBps: FEE_RATE_BPS, feeCents: applied, period }], { session });
    }
    return applied;
  }

  /**
   * Taxa da LOJA ONLINE já recebida: o Mercado Pago separou a comissão do Balcão no pagamento (marketplace_fee).
   * Fica registrada para relatório (`collected`), mas NÃO vira dívida, não entra em fatura e não conta para o teto.
   */
  async recordCollectedFee(enterpriseId: string, saleId: Types.ObjectId, baseCents: number, rateBps: number, feeCents: number, session: ClientSession): Promise<number> {
    if (feeCents > 0) await this.feeModel.create([{ enterpriseId, saleId, baseCents, rateBps, feeCents, period: periodOf(), channel: 'online', collected: true }], { session });
    return Math.max(0, feeCents);
  }

  /**
   * Taxa da LOJA ONLINE em pedido pago na entrega (dinheiro, maquininha, Pix na mão): o Mercado Pago não separou nada,
   * então vira dívida e entra na fatura (não conta para o teto do balcão).
   */
  async recordUncollectedOnlineFee(enterpriseId: string, saleId: Types.ObjectId, baseCents: number, rateBps: number, session: ClientSession): Promise<number> {
    const enterprise = await this.enterpriseService.lockForBilling(enterpriseId, session);
    if (!enterprise || feeWaived(enterprise) || isFreeMonth(enterprise, periodOf())) return 0;
    const feeCents = onlineFeeCents(baseCents, rateBps);
    if (feeCents > 0) {
      await this.enterpriseService.addDebt(enterpriseId, feeCents, session);
      await this.feeModel.create([{ enterpriseId, saleId, baseCents, rateBps, feeCents, period: periodOf(), channel: 'online', collected: false }], { session });
    }
    return feeCents;
  }

  /** Pagamento online devolvido ao comprador: a comissão volta junto no Mercado Pago; marca no registro. */
  async reverseCollectedFee(saleId: Types.ObjectId): Promise<void> {
    await this.feeModel.updateOne({ saleId, collected: true, reversedAt: null }, { $set: { reversedAt: new Date() } });
  }

  /** Percentual da loja online conforme a origem do cliente. */
  async onlineRate(source: 'store' | 'directory'): Promise<number> {
    const p = await this.settings.policy();
    return source === 'directory' ? p.directoryRateBps : p.onlineRateBps;
  }

  /** Taxa da loja online no mês (sem estornadas). */
  private async monthOnlineFeeCents(enterpriseId: string, period: string): Promise<number> {
    const [agg] = await this.feeModel.aggregate<{ sum: number }>([
      { $match: { enterpriseId: new Types.ObjectId(enterpriseId), period, reversedAt: null, channel: 'online' } },
      { $group: { _id: null, sum: { $sum: '$feeCents' } } },
    ]);
    return agg?.sum ?? 0;
  }

  /** Taxa do BALCÃO já cobrada no mês (sem as estornadas). É a que conta para o teto. */
  private async monthFeeCents(enterpriseId: string, period: string, session?: ClientSession): Promise<number> {
    const [agg] = await this.feeModel
      .aggregate<{ sum: number }>([
        { $match: { enterpriseId: new Types.ObjectId(enterpriseId), period, reversedAt: null, channel: { $ne: 'online' } } },
        { $group: { _id: null, sum: { $sum: '$feeCents' } } },
      ])
      .session(session ?? null);
    return agg?.sum ?? 0;
  }

  /** Taxa ainda não faturada (de qualquer mês), sem as estornadas. */
  private async unbilledCents(enterpriseId: string): Promise<number> {
    const [agg] = await this.feeModel.aggregate<{ sum: number }>([
      { $match: { enterpriseId: new Types.ObjectId(enterpriseId), invoiceId: null, reversedAt: null, collected: { $ne: true } } },
      { $group: { _id: null, sum: { $sum: '$feeCents' } } },
    ]);
    return agg?.sum ?? 0;
  }

  /** Estorna a taxa de uma venda cancelada, desde que ainda não tenha sido faturada. */
  async reverseFee(enterpriseId: string, saleId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const entry = await this.feeModel.findOneAndUpdate(
      { saleId, enterpriseId, invoiceId: null, reversedAt: null, collected: { $ne: true } },
      { $set: { reversedAt: new Date() } },
      { session },
    );
    if (!entry) return false;
    await this.enterpriseService.addDebt(enterpriseId, -entry.feeCents, session);
    return true;
  }

  // ------------------------------------------------------------------ consulta

  async getSummary(enterpriseId: string) {
    const enterprise = await this.enterpriseService.findEnterpriseById(enterpriseId);
    const pending = await this.invoiceModel.find({ enterpriseId, status: 'pending' }).sort({ dueDate: 1 });
    const monthFeeCents = await this.monthFeeCents(enterpriseId, periodOf());
    const onlineMonthFeeCents = await this.monthOnlineFeeCents(enterpriseId, periodOf());
    const unbilled = await this.unbilledCents(enterpriseId);
    const waived = feeWaived(enterprise);
    const blocked = enterprise.billing?.status === 'blocked';
    const policy = await this.settings.policy();
    const cap = enterprise.feeCapCents ?? policy.capCents;
    const capReached = cap > 0 && monthFeeCents >= cap;
    return {
      // Taxa do MÊS ATUAL: vai acumulando até o teto e vira fatura no começo do mês seguinte (com 15 dias para pagar).
      // Não depende de a fatura do mês anterior já ter sido paga: as duas convivem.
      currentMonth: {
        period: periodOf(),
        feeCents: monthFeeCents,
        capCents: cap,
        capReached,
        onlineFeeCents: onlineMonthFeeCents, // loja online: já descontada pelo Mercado Pago (informativo)
        unbilledCents: unbilled,
        closesAt: nextMonthStart(),
        // Só dá para adiantar o pagamento depois de bater o teto do mês e se houver taxa ainda sem fatura.
        canPayEarly: capReached && unbilled > 0 && !waived,
      },
      pendingCents: pending.reduce((n, i) => n + i.amountCents, 0), // faturas já emitidas e não pagas
      rateBps: FEE_RATE_BPS,
      capCents: cap, // teto POR MÊS (o da empresa, se houver; senão o padrão)
      policy: { capCents: policy.capCents, trialDays: policy.trialDays, onlineRateBps: policy.onlineRateBps, directoryRateBps: policy.directoryRateBps },
      graceDays: graceDays(this.config.get('BILLING_GRACE_DAYS')),
      debtCents: enterprise.debtCents ?? 0, // total em aberto, inclui meses não pagos
      monthFeeCents,
      remainingCents: Math.max(0, cap - monthFeeCents),
      trial: { active: inTrial(enterprise), endsAt: trialEnd(enterprise), daysLeft: trialDaysLeft(enterprise), totalDays: Math.max(0, Math.round((trialEnd(enterprise).getTime() - ((enterprise as unknown as { createdAt?: Date }).createdAt ?? new Date()).getTime()) / 86_400_000)) },
      feeWaivedReason: waived, // 'trial' | 'exempt' | 'admin' | null
      nextDueDate: pending[0]?.dueDate ?? null, // se não pagar até aqui, a conta bloqueia
      salesBlocked: blocked,
      accountBlocked: blocked,
      pendingInvoices: pending.map((i) => this.present(i)),
    };
  }

  async listInvoices(enterpriseId: string) {
    const invoices = await this.invoiceModel.find({ enterpriseId }).sort({ createdAt: -1 }).limit(100);
    return invoices.map((i) => this.present(i));
  }

  // ------------------------------------------------------------------ faturas

  /**
   * Agrupa as taxas ainda não faturadas numa fatura. Atômico e idempotente:
   * cada FeeEntry só pode ser reivindicada por uma fatura.
   * beforePeriod: se informado, só inclui taxas de meses anteriores (fechamento mensal).
   */
  async issueInvoice(enterpriseId: string, opts: { kind: 'monthly' | 'on_demand'; dueDate: Date; beforePeriod?: string }): Promise<InvoiceDocument | null> {
    const session = await this.connection.startSession();
    try {
      let created: InvoiceDocument | null = null;
      await session.withTransaction(async () => {
        created = null;
        const invoiceId = new Types.ObjectId();
        const claim = await this.feeModel.updateMany(
          { enterpriseId, invoiceId: null, reversedAt: null, collected: { $ne: true }, ...(opts.beforePeriod ? { period: { $lt: opts.beforePeriod } } : {}) },
          { $set: { invoiceId } },
          { session },
        );
        if (claim.modifiedCount === 0) return;
        const [agg] = await this.feeModel
          .aggregate<{ sum: number; from: string; to: string }>([
            { $match: { invoiceId } },
            { $group: { _id: null, sum: { $sum: '$feeCents' }, from: { $min: '$period' }, to: { $max: '$period' } } },
          ])
          .session(session);
        const [invoice] = await this.invoiceModel.create(
          [{ _id: invoiceId, enterpriseId, kind: opts.kind, periodFrom: agg.from, periodTo: agg.to, amountCents: agg.sum, dueDate: opts.dueDate }],
          { session },
        );
        created = invoice;
      });
      return created;
    } finally {
      await session.endSession();
    }
  }

  /** Empresa pede para pagar agora (ex.: bateu o teto de R$ 40 no meio do mês). Também tem o prazo normal. */
  async issueInvoiceNow(enterpriseId: string) {
    const enterprise = await this.enterpriseService.findEnterpriseById(enterpriseId);
    const cap = enterprise.feeCapCents ?? (await this.settings.policy()).capCents;
    const monthFee = await this.monthFeeCents(enterpriseId, periodOf());
    // A taxa é mensal e não se paga antes do fechamento, exceto quando o teto do mês já foi atingido.
    if (!(cap > 0 && monthFee >= cap)) {
      throw new ConflictException('A taxa do mês só pode ser paga antes do fechamento depois de atingir o teto mensal. Ela vira fatura no começo do próximo mês.');
    }
    const existing = await this.invoiceModel.findOne({ enterpriseId, status: 'pending' }).sort({ dueDate: 1 });
    const invoice = await this.issueInvoice(enterpriseId, { kind: 'on_demand', dueDate: dueDateFrom(new Date(), graceDays(this.config.get('BILLING_GRACE_DAYS'))) });
    if (invoice) return this.present(invoice);
    if (existing) return this.present(existing);
    throw new ConflictException('Não há taxa em aberto para pagar');
  }

  /** Gera (ou reaproveita) o link de pagamento da fatura no Mercado Pago (Pix ou cartão), na conta do Balcão. */
  async payInvoice(enterpriseId: string, invoiceId: string) {
    const invoice = await this.invoiceModel.findOne({ _id: invoiceId, enterpriseId });
    if (!invoice) throw new NotFoundException('Fatura não encontrada');
    if (invoice.status !== 'pending') throw new ConflictException(`Fatura ${invoice.status === 'paid' ? 'já paga' : 'cancelada'}`);
    if (invoice.checkoutUrl) return this.present(invoice);

    // Reserva atômica (30 s): dois cliques/abas não criam dois links.
    const claimed = await this.invoiceModel.findOneAndUpdate(
      { _id: invoice._id, checkoutUrl: null, $or: [{ checkoutLockedAt: null }, { checkoutLockedAt: { $lt: new Date(Date.now() - 30_000) } }] },
      { $set: { checkoutLockedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!claimed) {
      const again = await this.invoiceModel.findById(invoice._id);
      if (again?.checkoutUrl) return this.present(again);
      throw new ConflictException('O link de pagamento está sendo gerado. Tente de novo em instantes.');
    }

    const enterprise = await this.enterpriseService.findEnterpriseById(enterpriseId);
    const id = String(invoice._id);
    const api = (this.config.get<string>('APP_URL') ?? '').replace(/\/$/, '');
    const front = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '');
    try {
      const pref = await this.mp.createPreference({
        accessToken: this.mp.platformToken,
        orderId: id,
        items: [{ title: `Taxa de uso do Balcão ERP (${invoice.periodFrom}${invoice.periodFrom !== invoice.periodTo ? ` a ${invoice.periodTo}` : ''})`, description: 'Taxa mensal de uso do sistema de vendas Balcão ERP', categoryId: 'services', quantity: 1, unitCents: invoice.amountCents }],
        payer: { name: enterprise.name, email: enterprise.email, document: enterprise.cnpj },
        backUrl: `${front}/app/pagamento?fatura=${id}`,
        notificationUrl: api.startsWith('https://') ? `${api}/billing/webhook/mercadopago?i=${id}&s=${sign('invoice', id)}` : undefined,
        statementDescriptor: 'BALCAO ERP',
      });
      const updated = await this.invoiceModel.findByIdAndUpdate(invoice._id, { $set: { checkoutUrl: pref.initPoint, preferenceId: pref.id } }, { returnDocument: 'after' });
      return this.present(updated!);
    } catch (e) {
      await this.invoiceModel.updateOne({ _id: invoice._id }, { $set: { checkoutLockedAt: null } }); // libera nova tentativa
      throw e;
    }
  }

  // ------------------------------------------------------------------ confirmação do pagamento

  /** Webhook do Mercado Pago para faturas: token por fatura na URL (+ x-signature, se configurado) e consulta do pagamento. */
  async handleMercadoPagoWebhook(q: Record<string, unknown>, body: Record<string, any>, headers: { signature?: string; requestId?: string } = {}): Promise<{ received: true; outcome: string }> {
    const id = String(q.i ?? '');
    if (!/^[a-f0-9]{24}$/i.test(id)) return { received: true, outcome: 'invoice_not_found' };
    if (!verifySigned('invoice', id, q.s)) throw new UnauthorizedException('Token inválido');
    const topic = String(q.type ?? q.topic ?? body?.type ?? body?.topic ?? '');
    const paymentId = String(q['data.id'] ?? body?.data?.id ?? (topic === 'payment' ? q.id ?? '' : ''));
    if (topic !== 'payment' || !/^\d{1,20}$/.test(paymentId)) return { received: true, outcome: 'ignored' };
    if (headers.signature && !this.mp.verifySignature(paymentId, headers.requestId, headers.signature)) throw new UnauthorizedException('Assinatura inválida');
    const outcome = await this.confirm(id, paymentId);
    await this.eventModel
      .create({ invoiceId: new Types.ObjectId(id), paymentId, outcome, raw: { topic, paymentId } })
      .catch((e) => this.logger.warn(`Falha ao registrar evento: ${e.message}`));
    return { received: true, outcome };
  }

  /** A empresa volta do checkout e confirma (caso o webhook demore). Só vale para fatura dela. */
  async confirmFromRedirect(enterpriseId: string, invoiceId: string, p: { paymentId: string }) {
    const invoice = await this.invoiceModel.findOne({ _id: invoiceId, enterpriseId });
    if (!invoice) throw new NotFoundException('Fatura não encontrada');
    const outcome = await this.confirm(String(invoice._id), p.paymentId);
    return { outcome, invoice: this.present((await this.invoiceModel.findById(invoice._id)) ?? invoice) };
  }

  /** Consulta o pagamento no Mercado Pago (conta do Balcão) e baixa a fatura se estiver aprovado com o valor certo. */
  private async confirm(invoiceId: string, paymentId: string): Promise<string> {
    const invoice = await crossTenant(this.invoiceModel, 'pagamento: fatura vinda do webhook (token assinado) ou da empresa já conferida').findById(invoiceId);
    if (!invoice) return 'invoice_not_found';
    if (invoice.status === 'paid') return 'already_paid';
    if (invoice.status !== 'pending') return 'ignored';
    if (!/^\d{1,20}$/.test(paymentId)) return 'unverifiable';

    const pay = await this.mp.payment(paymentId, this.mp.platformToken);
    if (pay.externalReference !== invoiceId) { this.logger.warn(`Pagamento ${paymentId} não é da fatura ${invoiceId}`); return 'not_this_invoice'; }
    if (pay.status !== 'approved') return 'not_paid';
    if (pay.amountCents < invoice.amountCents) {
      this.logger.error(`Valor divergente na fatura ${invoiceId}: esperado=${invoice.amountCents} pago=${pay.amountCents}`);
      return 'amount_mismatch';
    }
    await this.markPaid(invoice._id, { via: 'mercadopago', paymentId: pay.id, method: pay.method ?? undefined, paidAmountCents: pay.amountCents });
    return 'applied';
  }

  /** Idempotente: só a primeira chamada muda algo. Abate a dívida e reavalia o bloqueio. */
  async markPaid(invoiceId: Types.ObjectId | string, info: PaidInfo): Promise<boolean> {
    const session = await this.connection.startSession();
    try {
      let changed = false;
      await session.withTransaction(async () => {
        changed = false;
        const invoice = await crossTenant(this.invoiceModel, 'baixa da fatura já identificada (webhook, cartão ou admin)').findOneAndUpdate(
          { _id: invoiceId, status: 'pending' },
          { $set: { status: 'paid', paidAt: new Date(), paidVia: info.via, paymentId: info.paymentId ?? null, paymentMethod: info.method ?? null, paidAmountCents: info.paidAmountCents ?? null, note: info.note ?? null } },
          { session },
        );
        if (!invoice) return;
        await this.enterpriseService.addDebt(String(invoice.enterpriseId), -invoice.amountCents, session);
        await this.refreshBlockStatus(String(invoice.enterpriseId), session);
        changed = true;
      });
      return changed;
    } finally {
      await session.endSession();
    }
  }

  // ------------------------------------------------------------------ ações do admin

  async adminMarkPaid(invoiceId: string, note?: string): Promise<InvoiceDocument> {
    const ok = await this.markPaid(invoiceId, { via: 'manual', note });
    const inv = await this.invoiceModel.findById(invoiceId);
    if (!inv) throw new NotFoundException('Fatura não encontrada');
    if (!ok && inv.status !== 'paid') throw new ConflictException('Só faturas pendentes podem ser baixadas');
    return inv;
  }

  /** Cancela a fatura (perdão da taxa): abate a dívida e reavalia o bloqueio. */
  async adminCancelInvoice(invoiceId: string, note?: string): Promise<InvoiceDocument> {
    const session = await this.connection.startSession();
    try {
      let result: InvoiceDocument | null = null;
      await session.withTransaction(async () => {
        const invoice = await this.invoiceModel.findOneAndUpdate({ _id: invoiceId, status: 'pending' }, { $set: { status: 'cancelled', note: note ?? null } }, { returnDocument: 'after', session });
        if (!invoice) return;
        // Fatura perdoada: as taxas dela deixam de contar (inclusive para o teto do mês). Sem isso, cancelar uma fatura do
        // mês corrente deixaria o teto "estourado" e a empresa ficaria sem cobrança até o fim do mês.
        await this.feeModel.updateMany({ invoiceId: invoice._id, reversedAt: null }, { $set: { reversedAt: new Date() } }, { session });
        await this.enterpriseService.addDebt(String(invoice.enterpriseId), -invoice.amountCents, session);
        await this.refreshBlockStatus(String(invoice.enterpriseId), session);
        result = invoice;
      });
      if (!result) throw new ConflictException('Fatura não encontrada ou não está pendente');
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Reduz o valor de uma fatura pendente (desconto dado pelo admin). A dívida cai junto e o link de pagamento
   * antigo é descartado (tinha o valor velho); o próximo "pagar" gera um novo.
   */
  async adminReduceInvoice(invoiceId: string, amountCents: number, note?: string): Promise<{ invoice: InvoiceDocument; fromCents: number }> {
    const session = await this.connection.startSession();
    try {
      let out: { invoice: InvoiceDocument; fromCents: number } | null = null;
      await session.withTransaction(async () => {
        const inv = await this.invoiceModel.findOne({ _id: invoiceId, status: 'pending' }).session(session);
        if (!inv) throw new ConflictException('Fatura não encontrada ou não está pendente');
        if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents >= inv.amountCents) throw new ConflictException('O novo valor precisa ser menor que o atual e de pelo menos R$ 0,01 (para zerar, cancele a fatura)');
        const from = inv.amountCents;
        inv.amountCents = amountCents;
        inv.note = note ?? inv.note;
        inv.checkoutUrl = null; inv.preferenceId = null; inv.checkoutLockedAt = null;
        await inv.save({ session });
        await this.enterpriseService.addDebt(String(inv.enterpriseId), -(from - amountCents), session);
        out = { invoice: inv, fromCents: from };
      });
      await this.refreshBlockStatus(String(out!.invoice.enterpriseId));
      return out!;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Mês grátis: o mês não gera taxa. O que já foi lançado e não pago é estornado; faturas pendentes daquele mês
   * são reduzidas (ou canceladas, se zerarem). O que já foi pago não volta sozinho: vai em `alreadyPaidCents`.
   */
  async adminGrantFreeMonth(enterpriseId: string, period: string) {
    const problem = freeMonthProblem(period);
    if (problem) throw new ConflictException(problem);
    const session = await this.connection.startSession();
    const out = { period, reversedCents: 0, invoicesAdjusted: 0, invoicesCancelled: 0, alreadyPaidCents: 0 };
    try {
      await session.withTransaction(async () => {
        Object.assign(out, { reversedCents: 0, invoicesAdjusted: 0, invoicesCancelled: 0, alreadyPaidCents: 0 });
        const eid = new Types.ObjectId(enterpriseId);
        await this.enterpriseService.addFreeMonth(enterpriseId, period, session);
        const fees = await this.feeModel.find({ enterpriseId: eid, period, reversedAt: null, collected: { $ne: true } }).session(session).lean();
        const byInvoice = new Map<string, number>();
        let loose = 0;
        for (const f of fees) { if (f.invoiceId) byInvoice.set(String(f.invoiceId), (byInvoice.get(String(f.invoiceId)) ?? 0) + f.feeCents); else loose += f.feeCents; }
        const invs = byInvoice.size ? await this.invoiceModel.find({ _id: { $in: [...byInvoice.keys()].map((x) => new Types.ObjectId(x)) } }).session(session) : [];
        const reversible = new Set<string>(['__loose__']);
        for (const inv of invs) {
          const cut = byInvoice.get(String(inv._id)) ?? 0;
          if (inv.status === 'paid') { out.alreadyPaidCents += cut; continue; }
          if (inv.status !== 'pending') continue;
          reversible.add(String(inv._id));
          out.reversedCents += cut;
          const left = inv.amountCents - cut;
          if (left <= 0) { inv.status = 'cancelled'; out.invoicesCancelled++; } else { inv.amountCents = left; out.invoicesAdjusted++; }
          inv.note = `Mês grátis ${period}`; inv.checkoutUrl = null; inv.preferenceId = null; inv.checkoutLockedAt = null;
          await inv.save({ session });
        }
        out.reversedCents += loose;
        const ids = fees.filter((f) => !f.invoiceId || reversible.has(String(f.invoiceId))).map((f) => f._id);
        if (ids.length) await this.feeModel.updateMany({ _id: { $in: ids } }, { $set: { reversedAt: new Date() } }, { session });
        if (out.reversedCents) await this.enterpriseService.addDebt(enterpriseId, -out.reversedCents, session);
      });
      await this.refreshBlockStatus(enterpriseId);
      return out;
    } finally {
      await session.endSession();
    }
  }

  /** Tira um mês grátis (vale para as próximas vendas daquele mês; o que já foi estornado não volta). */
  async adminRevokeFreeMonth(enterpriseId: string, period: string) {
    await this.enterpriseService.removeFreeMonth(enterpriseId, period);
    return { period };
  }

  /** Estende o prazo (a partir de hoje, ou do vencimento atual se ainda não venceu). Desbloqueia se não houver outra vencida. */
  async adminExtendInvoice(invoiceId: string, days: number, note?: string): Promise<InvoiceDocument> {
    const inv = await this.invoiceModel.findOne({ _id: invoiceId, status: 'pending' });
    if (!inv) throw new ConflictException('Fatura não encontrada ou não está pendente');
    const base = inv.dueDate > new Date() ? inv.dueDate : new Date();
    inv.dueDate = dueDateFrom(base, days);
    if (note) inv.note = note;
    await inv.save();
    await this.refreshBlockStatus(String(inv.enterpriseId));
    return inv;
  }

  // ------------------------------------------------------------------ bloqueio / jobs

  /** Bloqueia a empresa se houver fatura pendente vencida; desbloqueia caso contrário. */
  async refreshBlockStatus(enterpriseId: string, session?: ClientSession) {
    const overdue = await this.invoiceModel.exists({ enterpriseId, status: 'pending', dueDate: { $lte: new Date() } }).session(session ?? null);
    await this.enterpriseService.setBlocked(enterpriseId, !!overdue, session);
  }

  /** Só reavalia bloqueios (barato; roda de hora em hora para o bloqueio não esperar a meia-noite). */
  async runBlockCheck(now: Date = new Date()) {
    const overdue = await crossTenant(this.invoiceModel, 'rotina: percorre as faturas de todas as lojas').distinct('enterpriseId', { status: 'pending', dueDate: { $lte: now } });
    for (const id of overdue) {
      try { await this.refreshBlockStatus(String(id)); } catch (e) { this.logger.error(`Falha ao atualizar bloqueio de ${id}: ${(e as Error).message}`); }
    }
  }

  /**
   * Rotina diária (idempotente): fatura as taxas de meses anteriores (vencimento = hoje + 15 dias)
   * e bloqueia quem tem fatura vencida.
   */
  async runDailyClose(now: Date = new Date()) {
    const current = periodOf(now);
    const dueDate = dueDateFrom(now, graceDays(this.config.get('BILLING_GRACE_DAYS')));
    const toInvoice = await crossTenant(this.feeModel, 'rotina: taxas sem fatura de todas as lojas').distinct('enterpriseId', { invoiceId: null, reversedAt: null, collected: { $ne: true }, period: { $lt: current } });
    for (const id of toInvoice) {
      try {
        const inv = await this.issueInvoice(String(id), { kind: 'monthly', dueDate, beforePeriod: current });
        if (inv) this.logger.log(`Fatura ${inv._id} emitida para ${id}: R$ ${(inv.amountCents / 100).toFixed(2)}`);
      } catch (e) {
        this.logger.error(`Falha ao faturar ${id}: ${(e as Error).message}`);
      }
    }
    await this.runBlockCheck(now);
  }

  // ------------------------------------------------------------------ helpers

  present(i: InvoiceDocument) {
    return {
      id: String(i._id),
      enterpriseId: String(i.enterpriseId),
      kind: i.kind,
      periodFrom: i.periodFrom,
      periodTo: i.periodTo,
      amountCents: i.amountCents,
      status: i.status,
      dueDate: i.dueDate,
      overdue: i.status === 'pending' && i.dueDate <= new Date(),
      paidAt: i.paidAt,
      paidVia: i.paidVia,
      paymentMethod: i.paymentMethod,
      checkoutUrl: i.checkoutUrl,
      note: i.note,
    };
  }


  private paymentRequired(code: string, message: string) {
    return new HttpException({ statusCode: HttpStatus.PAYMENT_REQUIRED, code, message }, HttpStatus.PAYMENT_REQUIRED);
  }
}

/** Taxa online em centavos, meio centavo arredondado para cima. */
export const onlineFeeCents = (baseCents: number, rateBps: number): number => (baseCents > 0 && rateBps > 0 ? Math.round((baseCents * rateBps) / 10_000) : 0);
