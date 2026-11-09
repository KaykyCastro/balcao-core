import { BadRequestException, GoneException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomInt } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';
import { crossTenant } from '../common/security/tenant-guard.plugin';
import { MailService } from '../mail/mail.service';
import { MessagesService } from '../messages/messages.service';
import { Store } from '../store/schema/store.schema';
import { AccessLog, AccountClosure, ConsentLog, PrivacyRequest } from './legal.schema';
import {
  CODE_MAX_WRONG, CODE_TTL_MIN, canMove, daysLeft, dueDate, protocolOf, REQUEST_KINDS, REQUESTER_ROLES, RESPONSE_DAYS, responseProblem,
  type RequestKind, type RequestStatus, type RequesterRole,
} from './legal.rules';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fmt = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
/** Campos que nunca saem numa exportação (senhas, tokens, códigos, chaves cifradas). */
const SECRET_KEY = /password|sealed|secret|token|codeHash|hash$|^tv$|tokenVersion|refresh|access(?!ed)/i;

@Injectable()
export class LegalService {
  private readonly logger = new Logger('Privacidade');
  /** Último registro de acesso por pessoa+IP: evita uma linha por requisição (basta uma por hora de uso). */
  private readonly seen = new Map<string, number>();

  constructor(
    @InjectModel(AccessLog.name) private readonly access: Model<AccessLog>,
    @InjectModel(ConsentLog.name) private readonly consents: Model<ConsentLog>,
    @InjectModel(AccountClosure.name) private readonly closures: Model<AccountClosure>,
    @InjectModel(PrivacyRequest.name) private readonly requests: Model<PrivacyRequest>,
    @InjectModel(Store.name) stores: Model<Store>,
    @InjectConnection() private readonly connection: Connection,
    private readonly mail: MailService,
    private readonly messages: MessagesService,
  ) {
    this.stores = crossTenant(stores, 'pedido LGPD: achar a loja citada pelo endereço público');
  }
  private readonly stores: Model<Store>;

  // ------------------------------------------------------------------ registros que a lei manda guardar

  /** Marco Civil, art. 15. Nunca derruba a requisição. */
  logAccess(a: { kind: 'enterprise' | 'staff' | 'admin' | 'shopper'; subjectId: string; accountId?: string | null; ip: string; userAgent: string }) {
    const key = `${a.kind}:${a.subjectId}:${a.ip}`;
    const now = Date.now();
    if ((this.seen.get(key) ?? 0) > now - 3_600_000) return;
    this.seen.set(key, now);
    if (this.seen.size > 50_000) for (const [k, t] of this.seen) if (t < now - 3_600_000) this.seen.delete(k);
    void this.access.create({
      kind: a.kind, subjectId: new Types.ObjectId(a.subjectId), accountId: a.accountId ? new Types.ObjectId(a.accountId) : null,
      ip: a.ip.slice(0, 64), userAgent: a.userAgent.slice(0, 300), at: new Date(now),
    }).catch((e) => this.logger.warn(`registro de acesso falhou: ${(e as Error).message}`));
  }

  /** Prova de aceite dos Termos/Política. Nunca derruba o cadastro. */
  async logConsent(c: { kind: 'enterprise' | 'shopper'; subjectId: string; email: string; termsVersion?: string | null; privacyVersion?: string | null; event: 'register' | 'accept' }) {
    try {
      await this.consents.create({ kind: c.kind, subjectId: new Types.ObjectId(c.subjectId), email: c.email.toLowerCase(), termsVersion: c.termsVersion ?? '', privacyVersion: c.privacyVersion ?? '', event: c.event, at: new Date() });
    } catch (e) { this.logger.warn(`prova de aceite falhou: ${(e as Error).message}`); }
  }

  /** Conta de lojista encerrada: fica o mínimo para as faturas guardadas e para defesa (5 anos). */
  async recordClosure(e: { _id: unknown; name?: string; email?: string; cnpj?: string; termsVersion?: string | null; termsAcceptedAt?: Date | null }, invoicesKept: number) {
    await this.closures.create({
      accountId: new Types.ObjectId(String(e._id)), name: e.name ?? '', email: (e.email ?? '').toLowerCase(), document: (e.cnpj ?? '').replace(/\D/g, ''),
      termsVersion: e.termsVersion ?? '', termsAcceptedAt: e.termsAcceptedAt ?? null, invoicesKept, closedAt: new Date(),
    });
  }

  // ------------------------------------------------------------------ portabilidade (lojista)

  /**
   * Cópia dos dados da conta (LGPD, art. 18, V): o cadastro e tudo que tem o enterpriseId desta conta, já sem senhas,
   * tokens e chaves. Dados cifrados no banco saem legíveis (o dono tem direito a eles).
   */
  async exportAccount(enterpriseId: string) {
    const id = new Types.ObjectId(enterpriseId);
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip);
      if (v instanceof Types.ObjectId) return String(v);
      if (v instanceof Date || !v || typeof v !== 'object') return v;
      if (Buffer.isBuffer(v)) return undefined;
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, strip(x)]));
    };
    const out: Record<string, unknown> = {};
    const ent = await this.connection.models.EnterpriseSchema?.findById(id).lean();
    for (const model of Object.values(this.connection.models)) {
      if (!model.schema.path('enterpriseId') || ['AuthChallenge', 'AuthHandoff', 'ProductEvent', 'Upload'].includes(model.modelName)) continue;
      const rows = await model.find({ enterpriseId: id }).limit(20_000).lean();
      if (rows.length) out[model.collection.collectionName] = strip(rows);
    }
    return {
      geradoEm: new Date().toISOString(),
      aviso: 'Cópia dos dados da sua conta no Balcão (LGPD, art. 18). Senhas, tokens e chaves de integração não são exportados.',
      conta: strip(ent ?? {}),
      dados: out,
    };
  }

  // ------------------------------------------------------------------ pedidos do titular

  async createRequest(d: { name: string; email: string; role: RequesterRole; kind: RequestKind; storeSlug?: string; details?: string }, ip: string) {
    const slug = (d.storeSlug ?? '').trim().toLowerCase();
    let storeEnterpriseId: Types.ObjectId | null = null;
    if (slug) {
      const s = await this.stores.findOne({ slug }).select('enterpriseId').lean();
      if (!s) throw new UnprocessableEntityException({ code: 'STORE_NOT_FOUND', message: 'Não achamos uma loja com esse endereço. Confira ou deixe em branco.' });
      storeEnterpriseId = s.enterpriseId as unknown as Types.ObjectId;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const r = await this.requests.create({
      name: d.name.trim(), email: d.email.trim().toLowerCase(), role: d.role, kind: d.kind, storeSlug: slug, storeEnterpriseId, details: (d.details ?? '').trim(),
      status: 'unverified', codeHash: hash(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000), ip: ip.slice(0, 64),
    });
    await this.mail.send(d.email, 'Confirme seu pedido sobre dados pessoais',
      `Olá, ${d.name.trim()}.\n\nRecebemos um pedido sobre seus dados pessoais: "${REQUEST_KINDS[d.kind]}".\nPara confirmar que o e-mail é seu, use este código: ${code}\n\nO código vale ${CODE_TTL_MIN} minutos. Se não foi você, ignore esta mensagem.`);
    return { id: String(r._id), expiresInMin: CODE_TTL_MIN };
  }

  async verifyRequest(id: string, code: string) {
    const r = await this.requests.findById(id).select('+codeHash');
    if (!r || r.status !== 'unverified') throw new NotFoundException('Pedido não encontrado ou já confirmado');
    if (!r.codeExpiresAt || r.codeExpiresAt < new Date()) throw new GoneException({ code: 'CODE_EXPIRED', message: 'O código venceu. Abra o pedido de novo.' });
    if (r.wrong >= CODE_MAX_WRONG) throw new GoneException({ code: 'CODE_LOCKED', message: 'Muitas tentativas. Abra o pedido de novo.' });
    if (hash(code.trim()) !== r.codeHash) {
      await this.requests.updateOne({ _id: r._id }, { $inc: { wrong: 1 } });
      throw new BadRequestException({ code: 'CODE_WRONG', message: 'Código incorreto' });
    }
    const now = new Date(); const year = now.getFullYear();
    const seq = (await this.requests.countDocuments({ protocol: new RegExp(`^LGPD-${year}-`) })) + 1;
    const protocol = protocolOf(year, seq);
    const due = dueDate(now);
    await this.requests.updateOne({ _id: r._id }, { $set: { status: 'open', protocol, verifiedAt: now, dueAt: due, codeHash: '', codeExpiresAt: null }, $push: { history: { at: now, status: 'open', by: 'titular', note: 'E-mail confirmado' } } });

    const what = REQUEST_KINDS[r.kind as RequestKind];
    await this.safeMail(r.email, `Pedido ${protocol} recebido`,
      `Olá, ${r.name}.\n\nSeu pedido foi registrado.\nProtocolo: ${protocol}\nPedido: ${what}\nPrazo de resposta: até ${fmt(due)} (${RESPONSE_DAYS} dias, LGPD art. 19).\n\nPodemos pedir alguma informação a mais para confirmar sua identidade antes de atender. Guarde o protocolo.`);
    const dpo = process.env.PRIVACY_EMAIL || process.env.ADMIN_EMAIL;
    if (dpo) await this.safeMail(dpo, `[LGPD] Novo pedido ${protocol}: ${what}`,
      `Protocolo: ${protocol}\nQuem: ${r.name} <${r.email}> (${REQUESTER_ROLES[r.role as RequesterRole]})\nPedido: ${what}\nLoja citada: ${r.storeSlug || '-'}\nPrazo: ${fmt(due)}\n\nDetalhes:\n${r.details || '-'}\n\nResponda pelo console do admin, em Sistema > Privacidade (LGPD).`);
    // Cliente de uma loja: a loja é a controladora desses dados e precisa saber (LGPD, art. 39: o operador segue o controlador).
    if (r.storeEnterpriseId) {
      await this.messages.notify(r.storeEnterpriseId, {
        title: `Pedido de dados pessoais (${protocol})`, level: 'warning', link: '/app/clientes',
        body: `${r.name} (${r.email}) pediu: "${what}". Pela LGPD, a resposta precisa sair até ${fmt(due)}. Veja o cadastro dessa pessoa em Clientes e responda pelo e-mail dela. O Balcão também acompanha o pedido.\n\nDetalhes: ${r.details || '-'}`,
      }).catch(() => undefined);
    }
    return { protocol, dueAt: due };
  }

  async adminList(status?: string) {
    const filter = status && status !== 'all' ? { status } : { status: { $ne: 'unverified' } };
    const rows = await this.requests.find(filter).sort({ status: 1, dueAt: 1 }).limit(300).lean();
    return rows.map((r) => ({
      id: String(r._id), protocol: r.protocol, name: r.name, email: r.email, role: r.role, kind: r.kind, storeSlug: r.storeSlug, details: r.details,
      status: r.status, verifiedAt: r.verifiedAt, dueAt: r.dueAt, daysLeft: r.dueAt && !r.closedAt ? daysLeft(r.dueAt) : null, response: r.response, closedAt: r.closedAt, history: r.history,
    }));
  }

  async adminUpdate(id: string, d: { status: RequestStatus; response?: string }, actor: string) {
    const r = await this.requests.findById(id);
    if (!r) throw new NotFoundException('Pedido não encontrado');
    if (!canMove(r.status as RequestStatus, d.status)) throw new UnprocessableEntityException('Esse pedido não pode ir para esse status');
    const response = (d.response ?? '').trim();
    const problem = responseProblem(d.status, response);
    if (problem) throw new UnprocessableEntityException(problem);
    const now = new Date(); const closing = d.status === 'done' || d.status === 'rejected';
    await this.requests.updateOne({ _id: r._id }, {
      $set: { status: d.status, ...(response ? { response } : {}), ...(closing ? { closedAt: now } : {}) },
      $push: { history: { at: now, status: d.status, by: actor, note: response.slice(0, 500) } },
    });
    if (closing) {
      await this.safeMail(r.email, `Resposta ao pedido ${r.protocol}`,
        `Olá, ${r.name}.\n\n${d.status === 'done' ? 'Seu pedido foi atendido.' : 'Não foi possível atender seu pedido, pelo motivo abaixo.'}\n\n${response}\n\nSe discordar, responda este e-mail. Você também pode reclamar à ANPD em gov.br/anpd.`);
    }
    return { ok: true };
  }

  private async safeMail(to: string, subject: string, text: string) {
    try { await this.mail.send(to, subject, text); } catch (e) { this.logger.warn(`e-mail não enviado: ${(e as Error).message}`); }
  }
}
