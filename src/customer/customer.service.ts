import { ConflictException, GoneException, Injectable, Logger, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagesService } from '../messages/messages.service';
import { MailService } from '../mail/mail.service';
import { randomToken, sha256 } from '../common/secret-box';
import { CustomerInviteCode } from './schema/invite-code.schema';
import { Types } from 'mongoose';
import { Shopper } from '../shopper/schema/shopper.schema';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, QueryFilter, Model } from 'mongoose';

import { CustomerSchema, CustomerDocument } from './schema/customer.schema';
import { CustomerPayment } from './schema/customer-payment.schema';
import { CustomerCreateDto } from './dto/customer-create.dto';
import { CustomerUpdateDto } from './dto/customer-update.dto';
import { CustomerPaymentDto } from './dto/customer-payment.dto';
import { PaginationQueryDto, Paginated } from '../common/dto/pagination-query.dto';
import { escapeRegex } from '../common/mongo';
import { toCents } from '../common/money';
import { CustomerLinkRequest, type CustomerLinkRequestDocument } from './schema/link-request.schema';
import { canLeave, canOwe, cleanMessage, isMember, matchReasons } from './membership.rules';
import { crossTenant } from '../common/security/tenant-guard.plugin';

const NOT_MEMBER = { code: 'CUSTOMER_NOT_MEMBER', message: 'Este cliente tem conta nas lojas do Balcão e ainda não é cliente da sua loja. Fiado só para quem pediu para ser cliente (ou aceitou o seu convite).' };
const INVITE_CODE_TTL_MS = 48 * 3_600_000;
const formatBRL = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

@Injectable()
export class CustomerService {
  constructor(
    @InjectModel(CustomerSchema.name) private readonly customerModel: Model<CustomerSchema>,
    @InjectModel(CustomerPayment.name) private readonly paymentModel: Model<CustomerPayment>,
    @InjectModel(Shopper.name) private readonly shopperModel: Model<Shopper>,
    @InjectModel(CustomerLinkRequest.name) private readonly requestModel: Model<CustomerLinkRequest>,
    @InjectConnection() private readonly connection: Connection,
    @Optional() @InjectModel(CustomerInviteCode.name) private readonly codeModel?: Model<CustomerInviteCode>,
    @Optional() private readonly messages?: MessagesService,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  // ------------------------------------------------------------------ avisos (nunca derrubam a ação)

  private readonly log = new Logger('Clientes');
  private get front() { return (this.config?.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, ''); }
  private async storeInfo(enterpriseId: string | Types.ObjectId) {
    try {
      const eid = new Types.ObjectId(String(enterpriseId));
      const [st, e] = await Promise.all([
        this.connection.collection('stores').findOne({ enterpriseId: eid }, { projection: { name: 1, slug: 1, enabled: 1 } }),
        this.connection.collection('enterpriseschemas').findOne({ _id: eid }, { projection: { name: 1 } }),
      ]);
      return { name: String(st?.name || e?.name || 'A loja'), slug: st?.enabled ? String(st.slug) : null };
    } catch { return { name: 'A loja', slug: null }; } // só para o texto do aviso
  }
  private notifyStore(enterpriseId: string | Types.ObjectId, title: string, body: string) {
    void this.messages?.notify(enterpriseId, { title, body, link: '/app/clientes' }).catch((e: Error) => this.log.warn(`Aviso não gravado: ${e.message}`));
  }
  private mailShopper(to: string, subject: string, text: string) {
    void this.mail?.send(to, subject, text).catch((e: Error) => this.log.warn(`E-mail não enviado: ${e.message}`));
  }


  // ------------------------------------------------------------------ conta online (comprador)

  /**
   * Cliente desta empresa ligado à conta online. Cria na primeira compra (dados da conta/checkout);
   * nas próximas só devolve o existente (o lojista pode ter editado nome/endereço).
   */
  async ensureForShopper(
    enterpriseId: string | Types.ObjectId,
    shopper: { _id: Types.ObjectId | string; name: string; email: string; phone?: string },
    address = '',
    session?: ClientSession,
  ): Promise<CustomerDocument> {
    const doc = await this.customerModel.findOneAndUpdate(
      { enterpriseId, shopperId: shopper._id },
      { $setOnInsert: { name: shopper.name, email: shopper.email, numberWithPrefix: shopper.phone ?? '', address, debitCents: 0, origin: 'online' } },
      { upsert: true, returnDocument: 'after', session },
    );
    return doc!;
  }

  // ------------------------------------------------------------------ pertencer à loja (pedido / convite)
  // Regras puras em membership.rules.ts. Nada liga uma conta online a um cadastro sem o "sim" das duas partes.

  private conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }

  private async verifiedShopper(by: { id?: string | Types.ObjectId; email?: string }) {
    const shopper = by.id ? await this.shopperModel.findById(by.id) : await this.shopperModel.findOne({ email: by.email!.trim().toLowerCase() });
    if (!shopper) throw new NotFoundException({ code: 'SHOPPER_NOT_FOUND', message: 'Nenhuma conta nas lojas do Balcão com esse e-mail. Peça ao cliente para criar a conta e pedir para ser cliente da sua loja.' });
    if (!shopper.emailVerifiedAt) this.conflict('SHOPPER_UNVERIFIED', 'A conta ainda não confirmou o e-mail. Abra o link que chegou no e-mail e tente de novo.');
    return shopper;
  }

  private async memberAt(enterpriseId: string | Types.ObjectId, shopperId: Types.ObjectId) {
    const c = await this.customerModel.findOne({ enterpriseId, shopperId });
    return c && isMember(c) ? c : null;
  }

  /** Comprador pede para ser cliente da loja. Se a loja já tinha convidado, os dois disseram sim: liga na hora. */
  async requestJoin(shopperId: Types.ObjectId | string, enterpriseId: string, message?: string) {
    const shopper = await this.verifiedShopper({ id: shopperId });
    if (await this.memberAt(enterpriseId, shopper._id as Types.ObjectId)) this.conflict('ALREADY_MEMBER', 'Você já é cliente desta loja.');
    const open = await this.requestModel.findOne({ enterpriseId, shopperId: shopper._id, status: 'pending' });
    if (open?.direction === 'invite') { await this.accept(open, open.customerId, 'shopper'); return { status: 'member' as const }; }
    if (open) return { status: 'pending' as const };
    const msg = cleanMessage(message);
    const created = await this.requestModel.create({
      enterpriseId, shopperId: shopper._id, direction: 'join', message: msg,
      person: { name: shopper.name, email: shopper.email, phone: shopper.phone ?? '' },
    }).catch((e) => { if ((e as { code?: number }).code !== 11000) throw e; return null; }); // dois cliques ao mesmo tempo
    if (created) this.notifyStore(enterpriseId, `${shopper.name} pediu para ser cliente da loja`,
      `${shopper.name} (${shopper.email}) pediu pelas Lojas no Balcão para ser cliente da sua loja.${msg ? `\n\nRecado: “${msg}”` : ''}\n\nEm Clientes, confira se já tem um cadastro dessa pessoa para unir, e aceite ou recuse.`);
    return { status: 'pending' as const };
  }

  /** Lojista convida a pessoa do marketplace a ligar a conta a este cadastro (ela precisa aceitar). */
  async invite(enterpriseId: string, customerId: string, email: string) {
    const customer = await this.getCustomerById(enterpriseId, customerId);
    if (customer.shopperId && isMember(customer)) this.conflict('ALREADY_MEMBER', 'Este cliente já está ligado a uma conta online.');
    const shopper = await this.verifiedShopper({ email });
    const sid = shopper._id as Types.ObjectId;
    if (customer.shopperId && String(customer.shopperId) !== String(sid)) this.conflict('SHOPPER_TAKEN', 'Este cadastro veio de outra conta online. Use o cadastro certo ou crie um novo.');
    const member = await this.memberAt(enterpriseId, sid);
    if (member) this.conflict('SHOPPER_TAKEN', `Essa conta já pertence à sua loja como "${member.name}".`);
    const open = await this.requestModel.findOne({ enterpriseId, shopperId: sid, status: 'pending' });
    if (open?.direction === 'join') { await this.accept(open, customer._id as Types.ObjectId, 'store'); return { status: 'member' as const }; } // ela já tinha pedido
    if (open) { open.customerId = customer._id as Types.ObjectId; await open.save(); return { status: 'invited' as const }; }
    await this.requestModel.create({ enterpriseId, shopperId: sid, direction: 'invite', customerId: customer._id });
    const st = await this.storeInfo(enterpriseId);
    this.mailShopper(shopper.email, `${st.name} convidou você para ser cliente da loja`,
      `Olá, ${shopper.name.split(' ')[0]}!\n\n${st.name} convidou você para ser cliente da loja no Balcão. Aceitando, você vê na sua conta o saldo, as compras e os pagamentos feitos lá, e a loja pode registrar compras para pagar depois (fiado). Para sair, o saldo precisa estar quitado.\n\nPara aceitar ou recusar, abra: ${this.front}/conta?aba=debitos\n\nSe você não conhece essa loja, é só recusar.`);
    return { status: 'invited' as const };
  }

  /** Pedidos e convites em aberto da loja, com sugestões de cadastro parecido para unir. */
  async pendingFor(enterpriseId: string) {
    const rows = await this.requestModel.find({ enterpriseId, status: 'pending' }).sort({ createdAt: -1 }).limit(100).lean();
    if (!rows.length) return { items: [] };
    const shoppers = await this.shopperModel.find({ _id: { $in: rows.map((r) => r.shopperId) } }).select('name email phone').lean();
    const own = await this.customerModel.find({ enterpriseId }).select('name email numberWithPrefix debitCents shopperId origin memberSince').limit(5000).lean();
    const invited = await this.customerModel.find({ enterpriseId, _id: { $in: rows.map((r) => r.customerId).filter(Boolean) } }).select('name').lean();
    return {
      items: rows.map((r) => {
        const sh = shoppers.find((x) => String(x._id) === String(r.shopperId));
        const person = r.person ?? { name: sh?.name ?? '', email: sh?.email ?? '', phone: sh?.phone ?? '' };
        const suggestions = r.direction === 'join'
          // Só cadastros do lojista ainda sem conta online; o cadastro automático da compra online é o "não tenho outro".
          ? own.filter((c) => !c.shopperId)
            .map((c) => ({ c, m: matchReasons(c, person) })).filter((x) => x.m.score >= 30)
            .sort((a, b) => b.m.score - a.m.score).slice(0, 3)
            .map(({ c, m }) => ({ id: String(c._id), name: c.name, phone: c.numberWithPrefix, email: c.email, debitCents: c.debitCents ?? 0, reasons: m.reasons }))
          : [];
        const online = own.find((c) => String(c.shopperId) === String(r.shopperId));
        return {
          id: String(r._id), direction: r.direction, at: (r as { createdAt?: Date }).createdAt, message: r.message, person, suggestions,
          onlineCustomer: online ? { id: String(online._id), name: online.name } : null,
          customer: r.customerId ? { id: String(r.customerId), name: invited.find((c) => String(c._id) === String(r.customerId))?.name ?? '' } : null,
        };
      }),
    };
  }

  /** Lojista aceita o pedido: liga a um cadastro que já existe (une os dois) ou cria um novo. */
  async acceptJoin(enterpriseId: string, requestId: string, customerId?: string | null) {
    const r = await this.requestModel.findOne({ _id: requestId, enterpriseId, status: 'pending', direction: 'join' });
    if (!r) throw new NotFoundException('Pedido não encontrado ou já respondido');
    if (customerId) await this.getCustomerById(enterpriseId, customerId);
    return this.accept(r, customerId ? new Types.ObjectId(customerId) : null, 'store');
  }

  async declineRequest(enterpriseId: string, requestId: string) {
    const r = await this.requestModel.findOneAndUpdate({ _id: requestId, enterpriseId, status: 'pending' }, { $set: { status: 'declined', decidedAt: new Date() } });
    if (!r) throw new NotFoundException('Pedido não encontrado ou já respondido');
    if (r.direction === 'join' && r.person?.email) {
      const st = await this.storeInfo(enterpriseId);
      this.mailShopper(r.person.email, `Seu pedido para ser cliente de ${st.name}`, `Olá, ${r.person.name.split(' ')[0]}.\n\n${st.name} não aceitou o pedido para ser cliente da loja por enquanto. Se você compra lá, fale com a loja: ela pode enviar um convite para a sua conta.`);
    }
  }

  /** Lado do comprador: convites recebidos e pedidos feitos ainda em aberto. */
  pendingOfShopper(shopperId: Types.ObjectId | string) {
    return crossTenant(this.requestModel, 'conta do comprador: convites e pedidos dele').find({ shopperId, status: 'pending' }).sort({ createdAt: -1 }).lean();
  }

  async shopperAnswer(shopperId: Types.ObjectId | string, requestId: string, answer: 'accept' | 'decline') {
    const r = await this.requestModel.findOne({ _id: requestId, shopperId, status: 'pending' });
    if (!r) throw new NotFoundException('Convite não encontrado ou já respondido');
    if (answer === 'accept') {
      if (r.direction !== 'invite') throw new NotFoundException('Convite não encontrado');
      await this.verifiedShopper({ id: shopperId });
      return this.accept(r, r.customerId, 'shopper');
    }
    r.status = r.direction === 'invite' ? 'declined' : 'cancelled'; r.decidedAt = new Date(); await r.save();
    if (r.direction === 'invite') {
      const sh = await this.shopperModel.findById(shopperId).select('name').lean();
      this.notifyStore(r.enterpriseId, `${sh?.name ?? 'O cliente'} recusou o convite`, `${sh?.name ?? 'O cliente'} recusou o convite para ligar a conta das Lojas no Balcão ao cadastro da sua loja.`);
    }
    return null;
  }

  /**
   * Liga a conta ao cadastro escolhido. Se a conta já tinha um cadastro automático (de compra online),
   * ele é unido ao escolhido: compras, pedidos e saldo passam para um só.
   */
  private async accept(r: CustomerLinkRequestDocument, targetId: Types.ObjectId | null, by: 'store' | 'shopper' | 'qr'): Promise<CustomerDocument> {
    const shopper = await this.shopperModel.findById(r.shopperId);
    if (!shopper) throw new NotFoundException('Conta online não encontrada');
    const eid = String(r.enterpriseId);
    const session = await this.connection.startSession();
    try {
      let out!: CustomerDocument;
      await session.withTransaction(async () => {
        const auto = await this.customerModel.findOne({ enterpriseId: eid, shopperId: shopper._id }).session(session);
        let target = targetId ? await this.customerModel.findOne({ _id: targetId, enterpriseId: eid }).session(session) : auto;
        if (targetId && !target) throw new NotFoundException('Cliente não encontrado');
        if (target && target.shopperId && String(target.shopperId) !== String(shopper._id)) this.conflict('SHOPPER_TAKEN', `"${target.name}" já está ligado a outra conta online.`);
        if (target && auto && String(auto._id) !== String(target._id)) await this.mergeInto(eid, auto, target, session);
        if (!target) {
          [target] = await this.customerModel.create([{ enterpriseId: eid, name: shopper.name, email: shopper.email, numberWithPrefix: shopper.phone ?? '', debitCents: 0, origin: 'online' }], { session });
        }
        target!.shopperId = shopper._id as Types.ObjectId;
        target!.memberSince = new Date();
        if (!target!.email) target!.email = shopper.email;
        if (!target!.numberWithPrefix && shopper.phone) target!.numberWithPrefix = shopper.phone;
        await target!.save({ session });
        await this.requestModel.updateOne({ _id: r._id }, { $set: { status: 'accepted', customerId: target!._id, decidedAt: new Date() } }, { session });
        out = target!;
      });
      if (by === 'store') {
        const st = await this.storeInfo(eid);
        this.mailShopper(shopper.email, `Agora você é cliente de ${st.name}`, `Olá, ${shopper.name.split(' ')[0]}!\n\n${st.name} aceitou você como cliente da loja. Na sua conta você vê o saldo, as compras e os pagamentos feitos lá: ${this.front}/conta?aba=debitos`);
      } else {
        this.notifyStore(eid, by === 'qr' ? `${shopper.name} entrou pelo QR de convite` : `${shopper.name} aceitou o convite`,
          `${shopper.name} (${shopper.email}) agora é cliente da loja, com o cadastro “${out.name}”. O saldo e as compras daqui aparecem na conta das Lojas no Balcão, e você pode vender fiado.`);
      }
      return out;
    } finally { await session.endSession(); }
  }

  // ------------------------------------------------------------------ QR de convite (uso único, 48 h)

  /** Gera o código do QR para este cadastro. Um código novo invalida os anteriores ainda não usados. */
  async createInviteCode(enterpriseId: string, customerId: string) {
    const c = await this.getCustomerById(enterpriseId, customerId);
    if (isMember(c)) this.conflict('ALREADY_MEMBER', 'Este cliente já está ligado a uma conta online.');
    await this.codeModel!.deleteMany({ enterpriseId, customerId: c._id, usedAt: null });
    const token = randomToken();
    const expiresAt = new Date(Date.now() + INVITE_CODE_TTL_MS);
    await this.codeModel!.create({ enterpriseId, customerId: c._id, tokenHash: sha256(token), expiresAt });
    return { token, url: `${this.front}/conta/convite/${token}`, expiresAt };
  }

  private async codeOf(token: string) {
    const code = /^[\w-]{20,64}$/.test(token) ? await this.codeModel!.findOne({ tokenHash: sha256(token) }) : null;
    if (!code) throw new NotFoundException({ code: 'INVITE_NOT_FOUND', message: 'Convite não encontrado. Peça à loja um QR novo.' });
    if (code.usedAt) throw new GoneException({ code: 'INVITE_USED', message: 'Este convite já foi usado. Peça à loja um QR novo.' });
    if (code.expiresAt <= new Date()) throw new GoneException({ code: 'INVITE_EXPIRED', message: 'Este convite venceu. Peça à loja um QR novo.' });
    return code;
  }

  /** Para a tela do convite: de qual loja é (sem mostrar dados do cadastro a quem só tem o link). */
  async previewCode(token: string) {
    const code = await this.codeOf(token);
    return { enterpriseId: code.enterpriseId, expiresAt: code.expiresAt };
  }

  /** O cliente leu o QR e aceitou: fica ligado ao cadastro que a loja escolheu. */
  async redeemCode(shopperId: Types.ObjectId | string, token: string) {
    const shopper = await this.verifiedShopper({ id: shopperId });
    const code = await this.codeOf(token);
    const sid = shopper._id as Types.ObjectId;
    const member = await this.memberAt(code.enterpriseId, sid);
    if (member && String(member._id) === String(code.customerId)) return member;
    if (member) this.conflict('ALREADY_MEMBER', 'Você já é cliente desta loja.');
    // Reserva o código antes de ligar: dois celulares lendo o mesmo QR não ligam duas contas.
    const claimed = await this.codeModel!.findOneAndUpdate({ _id: code._id, usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date(), usedBy: sid } });
    if (!claimed) throw new GoneException({ code: 'INVITE_USED', message: 'Este convite já foi usado. Peça à loja um QR novo.' });
    try {
      let r = await this.requestModel.findOne({ enterpriseId: code.enterpriseId, shopperId: sid, status: 'pending' });
      if (r) { r.direction = 'invite'; r.customerId = code.customerId; await r.save(); }
      else r = await this.requestModel.create({ enterpriseId: code.enterpriseId, shopperId: sid, direction: 'invite', customerId: code.customerId });
      return await this.accept(r, code.customerId, 'qr');
    } catch (e) {
      await this.codeModel!.updateOne({ _id: code._id }, { $set: { usedAt: null, usedBy: null } }); // não ligou: o QR continua valendo
      throw e;
    }
  }

  /** Comprador sai da loja (só com o saldo quitado). O cadastro e o histórico ficam com a loja. */
  async leave(shopperId: Types.ObjectId | string, customerId: string) {
    const c = await this.customerModel.findOne({ _id: customerId, shopperId });
    if (!c) throw new NotFoundException('Loja não encontrada na sua conta');
    const out = await this.detach(c, 'Você tem');
    const sh = await this.shopperModel.findById(shopperId).select('name').lean();
    this.notifyStore(c.enterpriseId, `${sh?.name ?? c.name} deixou de ser cliente da loja`, `${sh?.name ?? c.name} desligou a conta das Lojas no Balcão do cadastro “${c.name}” (saldo quitado). O cadastro e o histórico continuam com você.`);
    return out;
  }

  /** Lojista desliga a conta online do cadastro (só com o saldo quitado, igual à saída do cliente). */
  async unlinkShopper(enterpriseId: string, id: string): Promise<CustomerDocument> {
    return this.detach(await this.getCustomerById(enterpriseId, id), 'O cliente tem');
  }

  private async detach(c: CustomerDocument, who: string) {
    if (!canLeave(c)) this.conflict('DEBT_OPEN', `${who} ${formatBRL(c.debitCents)} em aberto nesta loja. Só dá para sair com o saldo quitado.`);
    c.shopperId = null; c.memberSince = null;
    await c.save();
    return c;
  }

  /** Move vendas, pedidos e saldo de um cadastro para outro e apaga o primeiro. */
  private async mergeInto(enterpriseId: string, from: CustomerDocument, to: CustomerDocument, session?: ClientSession) {
    const db = this.connection; const eid = new Types.ObjectId(enterpriseId);
    await db.collection('sales').updateMany({ enterpriseId: eid, customerId: from._id }, { $set: { customerId: to._id } }, { session });
    await db.collection('orders').updateMany({ enterpriseId: eid, customerId: from._id }, { $set: { customerId: to._id } }, { session });
    await this.paymentModel.updateMany({ enterpriseId: eid, customerId: from._id }, { $set: { customerId: to._id } }, { session });
    to.debitCents = (to.debitCents ?? 0) + (from.debitCents ?? 0);
    if (!to.address && from.address) to.address = from.address;
    await from.deleteOne({ session });
  }

  /** Todos os cadastros (um por loja) ligados a esta conta online. */
  forShopper(shopperId: string | Types.ObjectId) {
    return crossTenant(this.customerModel, 'conta do comprador: lojas onde ele é cliente').find({ shopperId }).lean();
  }

  async forShopperAt(shopperId: string | Types.ObjectId, enterpriseId: string | Types.ObjectId) {
    return this.customerModel.findOne({ shopperId, enterpriseId }).lean();
  }

  paymentsOf(enterpriseId: string | Types.ObjectId, customerId: string | Types.ObjectId, limit = 100) {
    return this.paymentModel.find({ enterpriseId, customerId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  create(enterpriseId: string, dto: CustomerCreateDto): Promise<CustomerDocument> {
    return this.customerModel.create({ ...dto, enterpriseId });
  }

  async list(enterpriseId: string, q: PaginationQueryDto & { onlyWithDebt?: boolean }): Promise<Paginated<CustomerDocument>> {
    const filter: QueryFilter<CustomerSchema> = { enterpriseId };
    if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');
    if (q.onlyWithDebt) filter.debitCents = { $gt: 0 };
    const [items, total] = await Promise.all([
      this.customerModel.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      this.customerModel.countDocuments(filter),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async getCustomerById(enterpriseId: string, id: string): Promise<CustomerDocument> {
    const customer = await this.customerModel.findOne({ _id: id, enterpriseId });
    if (!customer) throw new NotFoundException('Cliente não encontrado');
    return customer;
  }

  async update(enterpriseId: string, id: string, dto: CustomerUpdateDto): Promise<CustomerDocument> {
    const updated = await this.customerModel.findOneAndUpdate(
      { _id: id, enterpriseId },
      { $set: dto },
      { returnDocument: 'after', runValidators: true },
    );
    if (!updated) throw new NotFoundException('Cliente não encontrado');
    return updated;
  }

  async delete(enterpriseId: string, id: string): Promise<void> {
    const customer = await this.getCustomerById(enterpriseId, id);
    if ((customer.debitCents ?? 0) > 0) throw new ConflictException('Cliente com débito em aberto');
    await customer.deleteOne();
  }

  /** Soma ao fiado (atômico, dentro da transação da venda). */
  async increaseDebit(enterpriseId: string, id: string, cents: number, session?: ClientSession) {
    const customer = await this.customerModel.findOneAndUpdate(
      // Fiado numa conta do marketplace só para quem pertence à loja (membership.rules.ts → canOwe).
      { _id: id, enterpriseId, $or: [{ shopperId: null }, { memberSince: { $ne: null } }, { origin: { $ne: 'online' } }] },
      { $inc: { debitCents: cents } },
      { returnDocument: 'after', session },
    );
    if (!customer) {
      if (await this.customerModel.exists({ _id: id, enterpriseId }).session(session ?? null)) throw new ConflictException(NOT_MEMBER);
      throw new NotFoundException('Cliente não encontrado');
    }
    return customer;
  }

  /** Erro antes de mexer em estoque: venda fiado para quem ainda não pertence à loja. */
  async assertCanOwe(enterpriseId: string, id: string) {
    const c = await this.getCustomerById(enterpriseId, id);
    if (!canOwe(c)) throw new ConflictException(NOT_MEMBER);
    return c;
  }

  /** Reduz o fiado até no máximo o saldo atual (usado no cancelamento de venda). */
  async reduceDebitUpTo(enterpriseId: string, id: string, cents: number, session?: ClientSession) {
    const full = await this.customerModel.findOneAndUpdate(
      { _id: id, enterpriseId, debitCents: { $gte: cents } },
      { $inc: { debitCents: -cents } },
      { session },
    );
    if (full) return;
    await this.customerModel.updateOne({ _id: id, enterpriseId }, { $set: { debitCents: 0 } }, { session });
  }

  /** Recebimento de fiado: não aceita valor maior que a dívida. */
  async receivePayment(enterpriseId: string, id: string, dto: CustomerPaymentDto) {
    const cents = toCents(dto.amount);
    const session = await this.connection.startSession();
    try {
      let result!: CustomerDocument;
      await session.withTransaction(async () => {
        const customer = await this.customerModel.findOneAndUpdate(
          { _id: id, enterpriseId, debitCents: { $gte: cents } },
          { $inc: { debitCents: -cents } },
          { returnDocument: 'after', session },
        );
        if (!customer) {
          const exists = await this.customerModel.exists({ _id: id, enterpriseId }).session(session);
          if (!exists) throw new NotFoundException('Cliente não encontrado');
          throw new UnprocessableEntityException('Valor maior que o débito do cliente');
        }
        await this.paymentModel.create(
          [{ enterpriseId, customerId: id, amountCents: cents, method: dto.method ?? 'cash' }],
          { session },
        );
        result = customer;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async listPayments(enterpriseId: string, id: string) {
    await this.getCustomerById(enterpriseId, id);
    return this.paymentModel.find({ enterpriseId, customerId: id }).sort({ createdAt: -1 }).limit(200);
  }
}
