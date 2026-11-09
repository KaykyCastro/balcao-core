import { decrypt } from '../common/security/field-crypto';
import { maskEmail } from '../common/legal-versions';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import { Shopper, ShopperDocument } from './schema/shopper.schema';
import { ShopperRegisterDto, ShopperUpdateDto } from './dto/shopper.dto';
import { BCRYPT_COST, DUMMY_HASH } from '../enterprise/enterprise.service';
import { MailService } from '../mail/mail.service';
import { LegalService } from '../legal/legal.service';
import { CustomerService } from '../customer/customer.service';
import { randomToken, sha256 } from '../common/secret-box';
import { readCookie } from '../auth/session-cookie';
import { SHOPPER_COOKIE, SHOPPER_SESSION_DAYS } from './shopper.cookie';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
const SLUG_RE = /^[a-z0-9-]{2,60}$/;

export interface ShopperClaims { sub: string; v: number; typ: 'shopper' }

@Injectable()
export class ShopperService {
  private readonly logger = new Logger(ShopperService.name);
  constructor(
    @InjectModel(Shopper.name) private readonly model: Model<Shopper>,
    @InjectConnection() private readonly connection: Connection,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly customers: CustomerService,
    @Optional() private readonly legal?: LegalService,
  ) {}

  private get front() { return (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173').replace(/\/$/, ''); }
  private back(from?: string) { return from && SLUG_RE.test(from) ? `?loja=${from}` : ''; }

  // ------------------------------------------------------------------ sessão

  token(s: Pick<ShopperDocument, '_id' | 'tokenVersion'>): string {
    const claims: ShopperClaims = { sub: String(s._id), v: s.tokenVersion ?? 0, typ: 'shopper' };
    return this.jwt.sign(claims, { expiresIn: `${SHOPPER_SESSION_DAYS}d` });
  }

  /** Conta logada pelo cookie (ou null). Confere a versão do token: troca de senha derruba sessões antigas. */
  async fromRequest(req: Pick<Request, 'headers'>): Promise<ShopperDocument | null> {
    const raw = readCookie(req, SHOPPER_COOKIE);
    if (!raw) return null;
    let claims: ShopperClaims;
    try { claims = this.jwt.verify<ShopperClaims>(raw); } catch { return null; }
    if (claims?.typ !== 'shopper' || !Types.ObjectId.isValid(claims.sub)) return null;
    const s = await this.model.findById(claims.sub);
    if (!s || (s.tokenVersion ?? 0) !== claims.v) return null;
    return s;
  }

  async register(dto: ShopperRegisterDto): Promise<ShopperDocument> {
    const exists = await this.model.exists({ email: dto.email });
    if (exists) throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'Já existe uma conta com esse e-mail. Entre com sua senha ou recupere o acesso.' });
    const verify = randomToken();
    let s: ShopperDocument;
    try {
      s = await this.model.create({
        name: dto.name, email: dto.email, phone: dto.phone ?? '', passwordHash: await bcrypt.hash(dto.password, BCRYPT_COST),
        verifyHash: sha256(verify), lastLoginAt: new Date(),
        consents: { acceptedAt: new Date(), termsVersion: dto.termsVersion ?? '', privacyVersion: dto.privacyVersion ?? '' },
      });
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'Já existe uma conta com esse e-mail.' });
      throw e;
    }
    await this.legal?.logConsent({ kind: 'shopper', subjectId: String(s._id), email: s.email, termsVersion: dto.termsVersion, privacyVersion: dto.privacyVersion, event: 'register' });
    await this.sendVerify(s, verify, dto.from);
    return s;
  }

  async login(email: string, password: string): Promise<ShopperDocument> {
    const s = await this.model.findOne({ email }).select('+passwordHash +failedLogins +lockUntil');
    if (s?.lockUntil && s.lockUntil > new Date()) {
      throw new UnauthorizedException({ code: 'LOCKED', message: 'Muitas tentativas. Tente de novo em alguns minutos ou redefina a senha.' });
    }
    const ok = await bcrypt.compare(password, s?.passwordHash ?? DUMMY_HASH);
    if (!s || !ok) {
      if (s) {
        const fails = (s.failedLogins ?? 0) + 1;
        await this.model.updateOne({ _id: s._id }, { $set: { failedLogins: fails >= MAX_FAILS ? 0 : fails, lockUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : null } });
      }
      throw new UnauthorizedException({ code: 'BAD_LOGIN', message: 'E-mail ou senha incorretos' });
    }
    await this.model.updateOne({ _id: s._id }, { $set: { failedLogins: 0, lockUntil: null, lastLoginAt: new Date() } });
    return s;
  }

  // ------------------------------------------------------------------ dados

  present(s: ShopperDocument | (Shopper & { _id: unknown })) {
    return {
      id: String(s._id), name: s.name, email: s.email, phone: s.phone ?? '', document: s.document ?? '',
      addresses: (s.addresses ?? []).map((a) => ({ label: a.label ?? '', cep: a.cep, street: a.street, number: a.number, complement: a.complement ?? '', district: a.district, city: a.city, state: a.state })),
      emailVerified: !!s.emailVerifiedAt,
      createdAt: (s as { createdAt?: Date }).createdAt ?? null,
      consents: s.consents ?? null,
    };
  }

  async update(s: ShopperDocument, dto: ShopperUpdateDto): Promise<ShopperDocument> {
    if (dto.name !== undefined) s.name = dto.name;
    if (dto.phone !== undefined) s.phone = dto.phone;
    if (dto.document !== undefined) s.document = dto.document;
    if (dto.addresses !== undefined) {
      s.addresses = dto.addresses.map((a) => ({
        label: a.label ?? '', cep: a.cep.replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2'), street: a.street, number: a.number,
        complement: a.complement ?? '', district: a.district, city: a.city, state: a.state.toUpperCase(),
      }));
    }
    await s.save();
    return s;
  }

  /** Depois da 1ª compra logada: guarda telefone/CPF e o endereço usado, se a conta ainda não tinha. */
  async rememberCheckout(s: ShopperDocument, c: { phone?: string; document?: string }, address: { cep: string; street: string; number: string; complement?: string; district: string; city: string; state: string } | null) {
    const set: Record<string, unknown> = {};
    if (!s.phone && c.phone) set.phone = c.phone;
    if (!s.document && c.document) set.document = c.document;
    const push = address && !(s.addresses ?? []).some((a) => a.cep.replace(/\D/g, '') === address.cep.replace(/\D/g, '') && a.number === address.number) && (s.addresses ?? []).length < 5;
    if (!Object.keys(set).length && !push) return;
    await this.model.updateOne({ _id: s._id }, {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(push ? { $push: { addresses: { label: (s.addresses ?? []).length ? '' : 'Casa', ...address, complement: address!.complement ?? '', state: address!.state.toUpperCase() } } } : {}),
    });
  }

  async changePassword(id: Types.ObjectId, current: string, next: string): Promise<ShopperDocument> {
    const s = await this.model.findById(id).select('+passwordHash');
    if (!s || !(await bcrypt.compare(current, s.passwordHash))) throw new BadRequestException({ code: 'BAD_PASSWORD', message: 'Senha atual incorreta' });
    s.passwordHash = await bcrypt.hash(next, BCRYPT_COST);
    s.tokenVersion = (s.tokenVersion ?? 0) + 1; // derruba as outras sessões
    await s.save();
    return s;
  }

  /**
   * Exclusão da conta (LGPD, art. 18, VI). Apaga a conta e desliga os vínculos.
   * Pedidos e cadastros de cliente ficam com as lojas (são delas e a lei fiscal/consumerista obriga a guardar), sem ligação com a conta.
   */
  async deleteAccount(id: Types.ObjectId, password: string) {
    const s = await this.model.findById(id).select('+passwordHash');
    if (!s || !(await bcrypt.compare(password, s.passwordHash))) throw new BadRequestException({ code: 'BAD_PASSWORD', message: 'Senha incorreta' });
    await this.erase(s._id);
    // Fica registrado (sem o e-mail completo) para provar que o pedido do titular foi atendido.
    await this.connection.collection(this.connection.models.AuditLog?.collection.collectionName ?? 'auditlogs').insertOne({
      actorId: s._id, actorEmail: 'titular (comprador)', action: 'shopper.delete', targetEnterpriseId: null,
      meta: { shopperId: String(s._id), email: maskEmail(s.email), by: 'titular' }, createdAt: new Date(),
    }).catch((e) => this.logger.warn(`Registro da exclusão não gravado: ${e.message}`));
    this.logger.log(`Conta de comprador ${s._id} excluída a pedido do titular`);
  }

  /** Apaga a conta e desfaz os vínculos. Pedidos e cadastros nas lojas ficam com as lojas (obrigação fiscal e do CDC). */
  async erase(id: Types.ObjectId | string) {
    const _id = new Types.ObjectId(String(id));
    await this.connection.collection('orders').updateMany({ shopperId: _id }, { $set: { shopperId: null } });
    await this.connection.collection(this.connection.models.CustomerSchema?.collection.collectionName ?? 'customerschemas').updateMany({ shopperId: _id }, { $set: { shopperId: null, memberSince: null } });
    await this.connection.collection('customer_link_requests').deleteMany({ shopperId: _id }); // pedidos e convites da conta apagada
    const r = await this.model.deleteOne({ _id });
    return r.deletedCount > 0;
  }

  /** "Sair de todos os aparelhos". */
  async revokeAll(id: Types.ObjectId) {
    await this.model.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
  }

  // ------------------------------------------------------------------ e-mail

  private async sendVerify(s: ShopperDocument, token: string, from?: string) {
    const link = `${this.front}/conta/verificar/${token}${this.back(from)}`;
    await this.mail.send(s.email, 'Confirme seu e-mail - Balcão',
      `Olá, ${s.name.split(' ')[0]}!\n\nSua conta de cliente do Balcão vale em todas as lojas que vendem pelo Balcão.\nConfirme seu e-mail para ver também seus pedidos antigos e os débitos que as lojas registrarem para você:\n\n${link}\n\nSe não foi você, ignore este e-mail.`,
    ).catch((e) => this.logger.warn(`E-mail de confirmação não enviado: ${e.message}`));
  }

  async resendVerify(s: ShopperDocument, from?: string) {
    if (s.emailVerifiedAt) return;
    const token = randomToken();
    await this.model.updateOne({ _id: s._id }, { $set: { verifyHash: sha256(token) } });
    await this.sendVerify(s, token, from);
  }

  /** Confirma o e-mail e traz para a conta os pedidos feitos antes como visitante com esse e-mail. */
  async verifyEmail(token: string): Promise<ShopperDocument> {
    const s = await this.model.findOneAndUpdate({ verifyHash: sha256(token) }, { $set: { emailVerifiedAt: new Date(), verifyHash: null } }, { returnDocument: 'after' });
    if (!s) throw new NotFoundException({ code: 'BAD_TOKEN', message: 'Link inválido ou já usado' });
    await this.claimGuestOrders(s).catch((e) => this.logger.error(`Falha ao trazer pedidos antigos de ${s._id}: ${e.message}`));
    return s;
  }

  private async claimGuestOrders(s: ShopperDocument) {
    const orders = this.connection.collection('orders');
    const guest = await orders.find({ 'customer.email': s.email, shopperId: { $in: [null, undefined] } }, { projection: { _id: 1, enterpriseId: 1, address: 1 } }).toArray();
    const byEnterprise = new Map<string, { ids: unknown[]; address: string }>();
    for (const o of guest) {
      const k = String(o.enterpriseId);
      const g = byEnterprise.get(k) ?? { ids: [], address: '' };
      g.ids.push(o._id);
      if (!g.address && o.address) g.address = fmtAddress(decryptAddress(o.address)); // leitura direta do driver: decifra aqui
      byEnterprise.set(k, g);
    }
    for (const [eid, g] of byEnterprise) {
      const c = await this.customers.ensureForShopper(eid, s, g.address);
      await orders.updateMany({ _id: { $in: g.ids as any[] } }, { $set: { shopperId: s._id, customerId: c._id } });
      await this.connection.collection('sales').updateMany({ orderId: { $in: g.ids as any[] }, customerId: null }, { $set: { customerId: c._id } });
    }
  }

  /** Resposta sempre igual: não revela se o e-mail tem conta. */
  async forgot(email: string, from?: string) {
    const token = randomToken();
    const s = await this.model.findOneAndUpdate({ email }, { $set: { resetHash: sha256(token), resetExpires: new Date(Date.now() + RESET_TTL_MS) } });
    if (!s) return;
    await this.mail.send(s.email, 'Redefinir senha - Balcão',
      `Para criar uma nova senha da sua conta de cliente, abra o link (vale por 1 hora):\n\n${this.front}/conta/redefinir/${token}${this.back(from)}\n\nSe não foi você, ignore este e-mail.`,
    ).catch((e) => this.logger.warn(`E-mail de senha não enviado: ${e.message}`));
  }

  async reset(token: string, password: string): Promise<ShopperDocument> {
    const s = await this.model.findOneAndUpdate(
      { resetHash: sha256(token), resetExpires: { $gt: new Date() } },
      // Quem recebeu o link no e-mail provou que é dono dele: confirma o e-mail também.
      { $set: { passwordHash: await bcrypt.hash(password, BCRYPT_COST), resetHash: null, resetExpires: null, failedLogins: 0, lockUntil: null }, $inc: { tokenVersion: 1 } },
      { returnDocument: 'after' },
    );
    if (!s) throw new NotFoundException({ code: 'BAD_TOKEN', message: 'Link inválido ou expirado. Peça outro.' });
    if (!s.emailVerifiedAt) {
      s.emailVerifiedAt = new Date();
      await s.save();
      await this.claimGuestOrders(s).catch(() => undefined);
    }
    return s;
  }
}

export function fmtAddress(a: { street?: string; number?: string; complement?: string; district?: string; city?: string; state?: string; cep?: string }): string {
  return [[a.street, a.number].filter(Boolean).join(', '), a.complement, a.district, [a.city, a.state].filter(Boolean).join('/'), a.cep].filter(Boolean).join(' - ');
}


/** Endereço lido direto do driver (sem o plugin do mongoose): decifra os campos protegidos. */
function decryptAddress(a: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, decrypt(v)])) as Parameters<typeof fmtAddress>[0];
}
