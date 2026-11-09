import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EnterpriseSchema } from '../enterprise/schema/enterprise.schema';
import { MailService } from '../mail/mail.service';
import { MessagesService } from '../messages/messages.service';
import { Invoice } from './schema/invoice.schema';
import { reminderDue, reminderText, waNumber } from './reminder.rules';
import { WhatsAppClient } from './whatsapp.client';
import { crossTenant } from '../common/security/tenant-guard.plugin';

/**
 * Avisos da fatura do sistema: e-mail (sempre), aviso no sino do painel e WhatsApp (se o lojista ativou).
 * Cada aviso é reservado na fatura antes de sair, então nunca vai duas vezes (nem com duas instâncias da API).
 */
@Injectable()
export class BillingNoticeService {
  private readonly log = new Logger('AvisosFatura');
  constructor(
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(EnterpriseSchema.name) private readonly enterprises: Model<EnterpriseSchema>,
    private readonly mail: MailService,
    private readonly messages: MessagesService,
    private readonly wa: WhatsAppClient,
    private readonly config: ConfigService,
  ) {}

  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, ''); }

  async run(now = new Date()) {
    const rows = await crossTenant(this.invoices, 'rotina: avisos das faturas em aberto de todas as lojas').find({ status: 'pending' }).sort({ dueDate: 1 }).limit(5000);
    let sent = 0;
    for (const inv of rows) {
      try { if (await this.remind(inv, now)) sent++; } catch (e) { this.log.error(`Aviso da fatura ${inv._id} falhou: ${(e as Error).message}`); }
    }
    if (sent) this.log.log(`${sent} aviso(s) de fatura enviados`);
    return sent;
  }

  private async remind(inv: Invoice & { _id: Types.ObjectId }, now: Date): Promise<boolean> {
    const e = await this.enterprises.findById(inv.enterpriseId).select('name email billingNotify autopay role').lean();
    if (!e || e.role === 'admin') return false;
    const autopay = e.autopay?.status === 'authorized' ? e.autopay : null;
    const kind = reminderDue(inv, now, { autopay: !!autopay });
    if (!kind) return false;
    // Reserva: só um processo manda este aviso desta fatura.
    const claimed = await this.invoices.updateOne({ _id: inv._id, status: 'pending', 'reminders.kind': { $ne: kind } }, { $push: { reminders: { kind, at: now, channels: [] } } });
    if (!claimed.modifiedCount) return false;
    const t = reminderText(kind, { name: e.name, amountCents: inv.amountCents, dueDate: inv.dueDate, link: `${this.front}/app/pagamento?fatura=${inv._id}`, autopay: autopay ? { chargeOn: autopay.nextChargeAt } : null });
    const channels: string[] = [];
    try { await this.mail.send(e.email, t.subject, t.text); channels.push('email'); } catch (err) { this.log.warn(`E-mail da fatura não saiu: ${(err as Error).message}`); }
    try { await this.messages.notify(inv.enterpriseId, { title: t.title, body: t.text, link: '/app/pagamento', level: kind === 'd1' || kind === 'overdue' ? 'warning' : 'info' }); channels.push('painel'); } catch { /* segue */ }
    const to = e.billingNotify?.whatsappOptInAt ? waNumber(e.billingNotify.whatsapp) : null;
    if (to && (await this.wa.sendInvoiceTemplate(to, [e.name.split(' ')[0] || e.name, t.short, (inv.amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' '), `${this.front}/app/pagamento?fatura=${inv._id}`]))) channels.push('whatsapp');
    await this.invoices.updateOne({ _id: inv._id, 'reminders.kind': kind }, { $set: { 'reminders.$.channels': channels } });
    return true;
  }

  // ------------------------------------------------------------------ preferências do lojista

  async settings(enterpriseId: string) {
    const e = await this.enterprises.findById(enterpriseId).select('email billingNotify').lean();
    return { email: e?.email ?? '', whatsapp: e?.billingNotify?.whatsapp ?? '', whatsappOn: !!e?.billingNotify?.whatsappOptInAt, whatsappAvailable: this.wa.configured };
  }

  /** WhatsApp só com número válido e o "sim" do lojista (guarda a data do aceite). */
  async save(enterpriseId: string, p: { whatsapp?: string; whatsappOn: boolean }) {
    const n = p.whatsapp ? waNumber(p.whatsapp) : null;
    if (p.whatsappOn && !n) throw new BadRequestException({ code: 'WHATSAPP_INVALID', message: 'Informe o celular com DDD para receber pelo WhatsApp.' });
    await this.enterprises.updateOne({ _id: enterpriseId }, { $set: { billingNotify: { whatsapp: n ?? '', whatsappOptInAt: p.whatsappOn ? new Date() : null } } });
    return this.settings(enterpriseId);
  }
}
