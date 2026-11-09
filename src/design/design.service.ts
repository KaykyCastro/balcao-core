import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Connection, Model, Types } from 'mongoose';
import { EnterpriseSchema } from '../enterprise/schema/enterprise.schema';
import { MessagesService } from '../messages/messages.service';
import { AuditLog } from '../admin/audit.schema';
import { DesignAccess, DesignAccessDocument } from './design-access.schema';
import { GRANT_DAYS, isLive, LIVE, OPEN, SESSION_HOURS } from './design.rules';

type Actor = { id: string; email: string };
export interface DesignSession { grantId: string; adminId: string; adminEmail: string; expiresAt: Date }
/** Conteúdo do token da sessão de design (mesmo segredo da sessão; `ds` limita tudo pelo DesignSessionGuard). */
export interface DesignClaims { sub: string; tv: number; ds: string; adm: string }

const oid = (s: string | Types.ObjectId) => new Types.ObjectId(String(s));
const fmt = (d: Date) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });

@Injectable()
export class DesignService {
  private readonly log = new Logger('Design');
  constructor(
    @InjectModel(DesignAccess.name) private readonly model: Model<DesignAccess>,
    @InjectModel(EnterpriseSchema.name) private readonly enterprises: Model<EnterpriseSchema>,
    @InjectModel(AuditLog.name) private readonly auditModel: Model<AuditLog>,
    @InjectConnection() private readonly connection: Connection,
    private readonly messages: MessagesService,
    private readonly jwt: JwtService,
  ) {}

  private audit(actor: Actor, action: string, target: string | Types.ObjectId, meta: Record<string, unknown>) {
    return this.auditModel.create({ actorId: oid(actor.id), actorEmail: actor.email, action, targetEnterpriseId: oid(target), meta })
      .catch((e: Error) => this.log.warn(`Auditoria não gravada: ${e.message}`));
  }
  private notify(eid: string | Types.ObjectId, title: string, body: string, link: string) {
    void this.messages.notify(eid, { title, body, link }).catch((e: Error) => this.log.warn(`Aviso não gravado: ${e.message}`));
  }

  /** Vencida sem ninguém encerrar: marca como vencida ao ler. */
  private async settle<T extends DesignAccessDocument | null>(g: T): Promise<T> {
    if (g && LIVE.includes(g.status) && g.expiresAt && g.expiresAt <= new Date()) {
      g.status = 'expired'; g.endedBy = 'expired'; g.finishedAt = new Date(); await g.save();
    }
    return g;
  }
  private present(g: DesignAccess & { _id: unknown; createdAt?: Date }) {
    return { id: String(g._id), status: g.status, adminEmail: g.adminEmail, message: g.message, requestedAt: g.createdAt, decidedAt: g.decidedAt, expiresAt: g.expiresAt, startedAt: g.startedAt, finishedAt: g.finishedAt, saves: g.saves, endedBy: g.endedBy };
  }

  // ------------------------------------------------------------------ admin

  async request(actor: Actor, enterpriseId: string, message: string) {
    const e = await this.enterprises.findById(enterpriseId).select('role name').lean();
    if (!e || e.role === 'admin') throw new NotFoundException('Empresa não encontrada');
    const store = await this.connection.collection('stores').findOne({ enterpriseId: oid(enterpriseId) }, { projection: { _id: 1 } });
    if (!store) throw new ConflictException({ code: 'NO_STORE', message: 'Essa empresa ainda não criou a loja online.' });
    const open = await this.settle(await this.model.findOne({ enterpriseId, status: { $in: OPEN } }).sort({ createdAt: -1 }));
    if (open && OPEN.includes(open.status)) throw new ConflictException({ code: 'DESIGN_OPEN', message: 'Já existe um pedido de acesso em aberto para essa loja.' });
    const g = await this.model.create({ enterpriseId: oid(enterpriseId), adminId: oid(actor.id), adminEmail: actor.email, message: message.trim().slice(0, 500), status: 'requested' });
    await this.audit(actor, 'design.request', enterpriseId, { id: String(g._id) });
    this.notify(enterpriseId, 'O Balcão pediu para montar o seu site',
      `A equipe do Balcão (${actor.email}) pediu acesso ao design da sua loja online para montar o site.${g.message ? `\n\nRecado: “${g.message}”` : ''}\n\nSe você combinou isso, permita em Loja online. A permissão vale uma vez: quando a montagem terminar, o acesso acaba sozinho. Pedidos, clientes, dinheiro e configurações da loja continuam fechados, e quem publica o site é você.`, '/app/loja');
    return this.present(g);
  }

  async listFor(enterpriseId: string) {
    const rows = await this.model.find({ enterpriseId }).sort({ createdAt: -1 }).limit(20);
    return { items: (await Promise.all(rows.map((r) => this.settle(r)))).map((r) => this.present(r!)) };
  }

  async cancel(actor: Actor, id: string) {
    const g = await this.model.findOneAndUpdate({ _id: id, status: 'requested' }, { $set: { status: 'cancelled', finishedAt: new Date(), endedBy: 'admin' } }, { returnDocument: 'after' });
    if (!g) throw new NotFoundException('Pedido não encontrado ou já respondido');
    await this.audit(actor, 'design.cancel', g.enterpriseId, { id });
    return this.present(g);
  }

  /** Abre a sessão de edição (só quem pediu, só com a permissão valendo) e devolve o token dela. */
  async startSession(actor: Actor, id: string) {
    const g = await this.settle(await this.model.findById(id));
    if (!g) throw new NotFoundException('Pedido não encontrado');
    if (String(g.adminId) !== actor.id) throw new ConflictException({ code: 'DESIGN_NOT_YOURS', message: 'Só quem fez o pedido abre a sessão.' });
    if (!isLive(g)) throw new ConflictException({ code: 'DESIGN_NOT_GRANTED', message: g.status === 'requested' ? 'O lojista ainda não permitiu.' : 'Essa permissão já acabou. Faça um novo pedido.' });
    const e = await this.enterprises.findById(g.enterpriseId).select('+tokenVersion name').lean();
    if (!e) throw new NotFoundException('Empresa não encontrada');
    if (g.status === 'granted') { g.status = 'in_progress'; g.startedAt = new Date(); await g.save(); await this.audit(actor, 'design.start', g.enterpriseId, { id }); }
    const until = Math.min(g.expiresAt!.getTime(), Date.now() + SESSION_HOURS * 3_600_000);
    const claims: DesignClaims = { sub: String(g.enterpriseId), tv: (e as { tokenVersion?: number }).tokenVersion ?? 0, ds: String(g._id), adm: actor.id };
    const token = this.jwt.sign(claims, { expiresIn: Math.max(60, Math.floor((until - Date.now()) / 1000)) });
    const store = await this.connection.collection('stores').findOne({ enterpriseId: g.enterpriseId }, { projection: { slug: 1, name: 1 } });
    return { token, expiresAt: new Date(until), store: { slug: store?.slug ?? null, name: store?.name || e.name }, grant: this.present(g) };
  }

  /** Admin terminou: a permissão acaba aqui e o lojista é avisado para revisar e publicar. */
  async finish(actor: Actor, id: string) {
    const g = await this.model.findOneAndUpdate({ _id: id, adminId: oid(actor.id), status: { $in: LIVE } }, { $set: { status: 'finished', finishedAt: new Date(), endedBy: 'admin' } }, { returnDocument: 'after' });
    if (!g) throw new NotFoundException('Sessão não encontrada ou já encerrada');
    await this.audit(actor, 'design.finish', g.enterpriseId, { id, saves: g.saves });
    this.notify(g.enterpriseId, 'O Balcão terminou de montar o seu site',
      `A montagem do site terminou e o acesso do Balcão ao design da sua loja foi encerrado.${g.saves ? ` O rascunho foi salvo ${g.saves} ${g.saves === 1 ? 'vez' : 'vezes'}.` : ''}\n\nAbra o construtor, confira o rascunho e clique em Publicar quando estiver do seu jeito.`, '/app/loja/site');
    return this.present(g);
  }

  // ------------------------------------------------------------------ lojista

  async currentFor(enterpriseId: string) {
    const g = await this.settle(await this.model.findOne({ enterpriseId }).sort({ createdAt: -1 }));
    return { current: g ? this.present(g) : null };
  }

  /** Permitir (uma vez, até GRANT_DAYS) ou recusar o pedido em aberto. */
  async decide(enterpriseId: string, id: string, allow: boolean) {
    const now = new Date();
    const g = await this.model.findOneAndUpdate({ _id: id, enterpriseId: oid(enterpriseId), status: 'requested' },
      { $set: allow ? { status: 'granted', decidedAt: now, expiresAt: new Date(now.getTime() + GRANT_DAYS * 86_400_000) } : { status: 'denied', decidedAt: now, finishedAt: now, endedBy: 'store' } },
      { returnDocument: 'after' });
    if (!g) throw new NotFoundException('Pedido não encontrado ou já respondido');
    this.notify(enterpriseId, allow ? 'Você permitiu o acesso ao design da loja' : 'Você recusou o acesso ao design da loja',
      allow ? `O Balcão pode montar o site da sua loja até ${fmt(g.expiresAt!)}, uma vez. Você pode revogar em Loja online quando quiser.` : 'Ninguém do Balcão mexe no design da sua loja sem um novo pedido e a sua permissão.', '/app/loja');
    return this.present(g);
  }

  /** Revogar: corta a sessão na hora (o token deixa de valer no próximo pedido). */
  async revoke(enterpriseId: string, id: string) {
    const g = await this.model.findOneAndUpdate({ _id: id, enterpriseId: oid(enterpriseId), status: { $in: LIVE } }, { $set: { status: 'revoked', finishedAt: new Date(), endedBy: 'store' } }, { returnDocument: 'after' });
    if (!g) throw new NotFoundException('Não há acesso ativo para revogar');
    return this.present(g);
  }

  // ------------------------------------------------------------------ sessão (JwtStrategy / guard)

  /** Confere a cada pedido: permissão valendo, da loja certa, aberta pelo admin que pediu e que continua admin. */
  async sessionFor(c: DesignClaims): Promise<DesignSession | null> {
    if (!Types.ObjectId.isValid(c.ds) || !Types.ObjectId.isValid(c.adm)) return null;
    const g = await this.model.findById(c.ds).lean();
    if (!g || !isLive(g) || String(g.enterpriseId) !== c.sub || String(g.adminId) !== c.adm) return null;
    const admin = await this.enterprises.findById(c.adm).select('role status').lean();
    if (!admin || admin.role !== 'admin' || admin.status === 'suspended') return null;
    return { grantId: String(g._id), adminId: c.adm, adminEmail: g.adminEmail, expiresAt: g.expiresAt! };
  }

  countSave(grantId: string) {
    void this.model.updateOne({ _id: grantId }, { $inc: { saves: 1 } }).catch(() => undefined);
  }
}
