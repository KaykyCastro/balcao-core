import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EnterpriseSchema } from '../enterprise/schema/enterprise.schema';
import { Message } from './message.schema';
import { InboxQuery, SendMessageDto, SentQuery } from './messages.dto';
import { crossTenant } from '../common/security/tenant-guard.plugin';

const BATCH = 500;
/** Remetente dos avisos automáticos (fora do histórico do admin). */
export const SYSTEM_SENDER = 'sistema@balcao';

@Injectable()
export class MessagesService {
  constructor(
    @InjectModel(Message.name) private readonly model: Model<Message>,
    @InjectModel(EnterpriseSchema.name) private readonly enterprises: Model<EnterpriseSchema>,
  ) {}

  // ------------------------------------------------------------ empresa (caixa de entrada)

  async inbox(enterpriseId: string, q: InboxQuery) {
    const filter = { enterpriseId: new Types.ObjectId(enterpriseId), ...(q.unread ? { readAt: null } : {}) };
    const [rows, total, unread] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.model.countDocuments(filter),
      this.unreadCount(enterpriseId),
    ]);
    return { items: rows.map((m) => this.present(m)), total, page: q.page, limit: q.limit, unread };
  }

  unreadCount(enterpriseId: string): Promise<number> {
    return this.model.countDocuments({ enterpriseId: new Types.ObjectId(enterpriseId), readAt: null });
  }

  /** Só marca mensagem DA PRÓPRIA empresa. Idempotente. */
  async markRead(enterpriseId: string, id: string) {
    const m = await this.model.findOneAndUpdate({ _id: id, enterpriseId, readAt: null }, { $set: { readAt: new Date() } }, { returnDocument: 'after' })
      ?? (await this.model.findOne({ _id: id, enterpriseId }));
    if (!m) throw new NotFoundException('Mensagem não encontrada');
    return this.present(m);
  }

  async markAllRead(enterpriseId: string) {
    const r = await this.model.updateMany({ enterpriseId, readAt: null }, { $set: { readAt: new Date() } });
    return { updated: r.modifiedCount };
  }

  // ------------------------------------------------------------ admin

  /** Envia para uma empresa ou, sem `enterpriseId`, para todas as ativas (contas admin não recebem). */
  async send(sender: { email: string }, dto: SendMessageDto): Promise<{ broadcastId: string; recipients: number }> {
    const broadcastId = new Types.ObjectId();
    const base = { broadcastId, title: dto.title, body: dto.body, level: dto.level ?? 'info', senderEmail: sender.email, readAt: null };
    if (dto.enterpriseId) {
      const target = await this.enterprises.findOne({ _id: dto.enterpriseId, role: 'user' }).select('_id');
      if (!target) throw new NotFoundException('Empresa não encontrada');
      await this.model.create({ ...base, enterpriseId: target._id });
      return { broadcastId: String(broadcastId), recipients: 1 };
    }
    let recipients = 0;
    let batch: Record<string, unknown>[] = [];
    const flush = async () => { if (batch.length) { await this.model.insertMany(batch, { ordered: false }); recipients += batch.length; batch = []; } };
    for await (const e of this.enterprises.find({ role: 'user', status: 'active' }).select('_id').cursor()) {
      batch.push({ ...base, enterpriseId: e._id });
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    if (!recipients) throw new BadRequestException('Nenhuma empresa ativa para receber');
    return { broadcastId: String(broadcastId), recipients };
  }

  /** Mesmo aviso para uma lista de empresas (um envio só no histórico). */
  async sendTo(sender: { email: string }, enterpriseIds: Types.ObjectId[], dto: Omit<SendMessageDto, 'enterpriseId'>) {
    const broadcastId = new Types.ObjectId();
    const base = { broadcastId, title: dto.title, body: dto.body, level: dto.level ?? 'info', senderEmail: sender.email, readAt: null };
    for (let i = 0; i < enterpriseIds.length; i += BATCH) {
      await this.model.insertMany(enterpriseIds.slice(i, i + BATCH).map((enterpriseId) => ({ ...base, enterpriseId })), { ordered: false });
    }
    return { broadcastId: String(broadcastId), recipients: enterpriseIds.length };
  }

  /**
   * Aviso automático para uma empresa (novidades da própria loja, ex.: pedido para ser cliente).
   * Não aparece no histórico de envios do admin (remetente do sistema). Falha não derruba a ação que avisou.
   */
  async notify(enterpriseId: string | Types.ObjectId, n: { title: string; body: string; link?: string; level?: 'info' | 'warning' }) {
    const link = n.link && /^\/app(\/[\w\-/?=&.%]*)?$/.test(n.link) ? n.link : '';
    await this.model.create({ enterpriseId: new Types.ObjectId(String(enterpriseId)), broadcastId: new Types.ObjectId(), title: n.title.slice(0, 120), body: n.body.slice(0, 2000), level: n.level ?? 'info', senderEmail: SYSTEM_SENDER, readAt: null, link });
  }

  /** Histórico de envios (um item por envio, com quantos receberam e quantos leram). */
  async sent(q: SentQuery) {
    const match = { senderEmail: { $ne: SYSTEM_SENDER }, ...(q.enterpriseId ? { enterpriseId: new Types.ObjectId(q.enterpriseId) } : {}) };
    const grouped = [
      { $match: match },
      { $group: { _id: '$broadcastId', title: { $first: '$title' }, body: { $first: '$body' }, level: { $first: '$level' }, senderEmail: { $first: '$senderEmail' }, createdAt: { $first: '$createdAt' }, enterpriseId: { $first: '$enterpriseId' }, recipients: { $sum: 1 }, read: { $sum: { $cond: [{ $ne: ['$readAt', null] }, 1, 0] } } } },
    ];
    const [rows, count] = await Promise.all([
      crossTenant(this.model, 'admin: histórico de avisos enviados a todas as lojas').aggregate<{ _id: Types.ObjectId; title: string; body: string; level: string; senderEmail: string; createdAt: Date; enterpriseId: Types.ObjectId; recipients: number; read: number }>([
        ...grouped, { $sort: { createdAt: -1 } }, { $skip: (q.page - 1) * q.limit }, { $limit: q.limit },
      ]),
      crossTenant(this.model, 'admin: histórico de avisos enviados a todas as lojas').aggregate<{ n: number }>([...grouped, { $count: 'n' }]),
    ]);
    const single = rows.filter((r) => r.recipients === 1).map((r) => r.enterpriseId);
    const names = new Map((await this.enterprises.find({ _id: { $in: single } }).select('name')).map((e) => [String(e._id), e.name]));
    return {
      items: rows.map((r) => ({
        id: String(r._id), title: r.title, body: r.body, level: r.level, senderEmail: r.senderEmail, createdAt: r.createdAt,
        recipients: r.recipients, read: r.read,
        enterpriseId: r.recipients === 1 ? String(r.enterpriseId) : null,
        enterpriseName: r.recipients === 1 ? names.get(String(r.enterpriseId)) ?? null : null,
      })),
      total: count[0]?.n ?? 0, page: q.page, limit: q.limit,
    };
  }

  /** Recolhe um envio: some da caixa de entrada de todos. Aceita o id do envio (broadcastId) ou de uma mensagem.
   *  Idempotente: recolher algo que já foi recolhido (clique duplo, lista desatualizada) não é erro. */
  async recall(id: string): Promise<{ removed: number }> {
    const r = await this.model.deleteMany({ $or: [{ broadcastId: id }, { _id: id }] });
    return { removed: r.deletedCount };
  }

  private present(m: Message & { _id: unknown; createdAt?: Date }) {
    return { id: String(m._id), title: m.title, body: m.body, level: m.level, createdAt: m.createdAt, readAt: m.readAt, link: m.link || null };
  }
}
