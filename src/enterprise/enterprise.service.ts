import { StorageService } from '../storage/storage.service';
import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { EnterpriseSchema, EnterpriseDocument } from './schema/enterprise.schema';
import { EnterpriseCreateDto } from './dto/enterprise-create.dto';
import { EnterpriseUpdateDto } from './dto/enterprise.update.dto';
import { isDuplicateKeyError } from '../common/mongo';
import { SettingsService } from '../settings/settings.service';
import { sanitizePdvLayout, type PdvLayoutData } from './pdv-layout.rules';
import { LegalService } from '../legal/legal.service';
import { OPEN_ORDER_STATUSES, RETAINED_ON_CLOSE } from '../legal/legal.rules';

export const BCRYPT_COST = 12;
/** Hash descartável para gastar o mesmo tempo quando o e-mail não existe (evita descobrir e-mails pelo tempo de resposta). */
export const DUMMY_HASH = bcrypt.hashSync('senha-que-nunca-sera-usada', BCRYPT_COST);

/** Coleções com dados da empresa apagadas junto com a conta. Faturas e razão de taxas ficam (registro financeiro). */

@Injectable()
export class EnterpriseService {
  private readonly logger = new Logger(EnterpriseService.name);

  constructor(
    @InjectModel(EnterpriseSchema.name) private readonly enterpriseModel: Model<EnterpriseSchema>,
    @InjectConnection() private readonly connection: Connection,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    @Optional() private readonly legal?: LegalService,
  ) {}

  async create(dto: EnterpriseCreateDto, terms?: { version: string; privacyVersion?: string | null }): Promise<EnterpriseDocument> {
    const email = dto.email.trim().toLowerCase();
    if (await this.enterpriseModel.exists({ email })) throw new ConflictException('Já existe uma empresa com esse e-mail');
    const password = await bcrypt.hash(dto.password, BCRYPT_COST);
    const { trialDays } = await this.settings.policy(); // 0 = sem teste grátis
    try {
      // Campos explícitos: impede injetar role/debtCents/billing/trial pelo body.
      const created = await this.enterpriseModel.create({
        name: dto.name, logo: '', email, password, cnpj: dto.cnpj,
        trialEndsAt: new Date(Date.now() + trialDays * 24 * 3600_000),
        ...(terms ? { termsAcceptedAt: new Date(), termsVersion: terms.version, privacyVersion: terms.privacyVersion ?? null } : {}),
      });
      if (terms) await this.legal?.logConsent({ kind: 'enterprise', subjectId: String(created._id), email, termsVersion: terms.version, privacyVersion: terms.privacyVersion, event: 'register' });
      // Logo no cadastro (base64 ou https): a pasta da empresa só existe depois de criada, então sobe agora.
      if (dto.logo) {
        created.logo = await this.storage.resolve(String(created._id), 'logo', dto.logo).catch(() => '');
        if (created.logo) await created.save();
      }
      return created;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe uma empresa com esse e-mail');
      throw e;
    }
  }

  async findEnterpriseById(id: string): Promise<EnterpriseDocument> {
    const enterprise = await this.enterpriseModel.findById(id);
    if (!enterprise) throw new NotFoundException('Empresa não encontrada');
    return enterprise;
  }

  /** Usado pelo JwtStrategy a cada request: traz também tokenVersion. */
  findForAuth(id: string): Promise<EnterpriseDocument | null> {
    return this.enterpriseModel.findById(id).select('+tokenVersion');
  }

  findByEmailForLogin(email: string): Promise<EnterpriseDocument | null> {
    return this.enterpriseModel.findOne({ email: email.trim().toLowerCase() }).select('+password +failedLogins +lockUntil +tokenVersion');
  }

  // ---------------------------------------------------------------- perfil

  async update(id: string, dto: EnterpriseUpdateDto): Promise<EnterpriseDocument> {
    const current = await this.enterpriseModel.findById(id).select('+password');
    if (!current) throw new NotFoundException('Empresa não encontrada');

    const newEmail = dto.email?.trim().toLowerCase();
    const changesEmail = newEmail !== undefined && newEmail !== current.email;
    if (changesEmail || dto.password !== undefined) {
      if (!dto.currentPassword || !(await bcrypt.compare(dto.currentPassword, current.password))) {
        throw new ForbiddenException('Senha atual incorreta');
      }
    }

    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.logo !== undefined) set.logo = await this.storage.resolve(id, 'logo', dto.logo);
    if (dto.cnpj !== undefined) set.cnpj = dto.cnpj;
    if (dto.staffMaxDiscountBps !== undefined) set.staffMaxDiscountBps = dto.staffMaxDiscountBps;
    if (dto.panelTheme !== undefined) set.panelTheme = dto.panelTheme ? { accent: dto.panelTheme.accent, chart: dto.panelTheme.chart } : null;
    if (changesEmail) set.email = newEmail;
    const update: Record<string, unknown> = { $set: set };
    if (dto.password !== undefined) {
      set.password = await bcrypt.hash(dto.password, BCRYPT_COST);
      update.$inc = { tokenVersion: 1 }; // derruba as outras sessões
    }

    try {
      const updated = await this.enterpriseModel.findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true });
      if (!updated) throw new NotFoundException('Empresa não encontrada');
      if (dto.logo !== undefined && current.logo !== updated.logo) await this.storage.release(id, [current.logo]); // logo antiga sai do R2
      return updated;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe uma empresa com esse e-mail');
      throw e;
    }
  }

  // ---------------------------------------------------------------- layout da tela de vendas

  async getPdvLayout(id: string): Promise<{ layout: PdvLayoutData | null; updatedAt: Date | null }> {
    const e = await this.enterpriseModel.findById(id).select('+pdvLayout pdvLayoutUpdatedAt').lean();
    if (!e) throw new NotFoundException('Empresa não encontrada');
    return { layout: (e.pdvLayout as PdvLayoutData) ?? null, updatedAt: e.pdvLayoutUpdatedAt ?? null };
  }

  /** Só o dono grava. A logo em data URL vai para o armazenamento; a antiga sai se ninguém mais usa. */
  async setPdvLayout(id: string, raw: unknown): Promise<{ layout: PdvLayoutData; updatedAt: Date }> {
    const current = await this.enterpriseModel.findById(id).select('+pdvLayout logo').lean();
    if (!current) throw new NotFoundException('Empresa não encontrada');
    const layout = sanitizePdvLayout(raw);
    const oldLogo = (current.pdvLayout as PdvLayoutData | null)?.logo as string | null | undefined;
    if (typeof layout.logo === 'string') layout.logo = (await this.storage.resolve(id, 'logo', layout.logo)) || null;
    const updatedAt = new Date();
    await this.enterpriseModel.updateOne({ _id: id }, { $set: { pdvLayout: layout, pdvLayoutUpdatedAt: updatedAt } });
    if (oldLogo && oldLogo !== layout.logo && oldLogo !== current.logo) await this.storage.release(id, [oldLogo]);
    return { layout, updatedAt };
  }

  /** Troca de senha com a senha atual. Invalida todos os tokens emitidos antes. */
  async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const e = await this.enterpriseModel.findById(id).select('+password');
    if (!e) throw new NotFoundException('Empresa não encontrada');
    if (!(await bcrypt.compare(currentPassword, e.password))) throw new ForbiddenException('Senha atual incorreta');
    await this.enterpriseModel.updateOne(
      { _id: id },
      { $set: { password: await bcrypt.hash(newPassword, BCRYPT_COST), passwordResetHash: null, passwordResetExpires: null }, $inc: { tokenVersion: 1 } },
    );
  }

  async revokeAllSessions(id: string): Promise<void> {
    await this.enterpriseModel.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
  }

  /** Mês grátis (admin, via BillingService). */
  async addFreeMonth(id: string, period: string, session?: ClientSession) {
    await this.enterpriseModel.updateOne({ _id: id }, { $addToSet: { freeMonths: period } }, { session });
  }
  async removeFreeMonth(id: string, period: string) {
    await this.enterpriseModel.updateOne({ _id: id }, { $pull: { freeMonths: period } });
  }

  /**
   * Exclui a conta e os dados dela (LGPD, art. 18, VI). Exige a senha, nenhuma taxa em aberto e nenhum pedido da loja
   * online ainda em andamento (o comprador não pode ficar sem resposta: CDC).
   * Apaga TODA coleção que tem enterpriseId (loja, pedidos, clientes, colaboradores, cupons, avaliações, arquivos…),
   * menos as faturas e os lançamentos da taxa (obrigação fiscal, 5 anos), que ficam com um registro mínimo do encerramento.
   * Registros de acesso (6 meses) e a prova de aceite dos termos (5 anos) também ficam: são obrigação legal.
   */
  async delete(id: string, password: string): Promise<void> {
    const enterprise = await this.enterpriseModel.findById(id).select('+password');
    if (!enterprise) throw new NotFoundException('Empresa não encontrada');
    if (enterprise.role === 'admin') throw new ForbiddenException('Contas de administrador não podem ser excluídas por aqui');
    if (!(await bcrypt.compare(password, enterprise.password))) throw new ForbiddenException('Senha incorreta');
    if ((enterprise.debtCents ?? 0) > 0) throw new ConflictException({ statusCode: 409, code: 'DEBT_OPEN', message: 'Existe taxa do Balcão em aberto. Quite antes de excluir a conta.' });
    const orders = this.connection.models.Order;
    const open = orders ? await orders.countDocuments({ enterpriseId: enterprise._id, status: { $in: [...OPEN_ORDER_STATUSES] } }) : 0;
    if (open > 0) throw new ConflictException({ statusCode: 409, code: 'ORDERS_OPEN', message: `A loja online tem ${open} pedido(s) em andamento. Entregue, cancele ou devolva antes de excluir a conta: o comprador não pode ficar sem resposta.` });

    const keep = new Set<string>(RETAINED_ON_CLOSE);
    const invoices = this.connection.models.Invoice ? await this.connection.models.Invoice.countDocuments({ enterpriseId: enterprise._id }) : 0;
    await this.legal?.recordClosure(enterprise, invoices);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const model of Object.values(this.connection.models)) {
          if (!model.schema.path('enterpriseId') || keep.has(model.modelName)) continue;
          await model.deleteMany({ enterpriseId: enterprise._id }, { session });
        }
        await this.enterpriseModel.deleteOne({ _id: enterprise._id }, { session });
      });
    } finally {
      await session.endSession();
    }
    // Arquivos: a pasta inteira da empresa no R2 e vídeos antigos que ainda estejam no GridFS.
    await this.storage.purgeOwner(String(enterprise._id)).catch(() => {});
    const db = this.connection.db!;
    const old = await db.collection('media.files').find({ 'metadata.enterpriseId': enterprise._id }).project({ _id: 1 }).toArray();
    if (old.length) {
      await db.collection('media.chunks').deleteMany({ files_id: { $in: old.map((f) => f._id) } });
      await db.collection('media.files').deleteMany({ _id: { $in: old.map((f) => f._id) } });
    }
    this.logger.log(`Conta ${String(enterprise._id)} excluída a pedido do titular (${invoices} fatura(s) mantidas por obrigação fiscal)`);
  }

  // ---------------------------------------------------------------- login / recuperação

  async registerLoginFailure(id: string, max: number, lockMs: number): Promise<void> {
    const e = await this.enterpriseModel.findOneAndUpdate({ _id: id }, { $inc: { failedLogins: 1 } }, { returnDocument: 'after' }).select('+failedLogins');
    if (e && (e.failedLogins ?? 0) >= max) {
      await this.enterpriseModel.updateOne({ _id: id }, { $set: { lockUntil: new Date(Date.now() + lockMs), failedLogins: 0 } });
    }
  }

  async registerLoginSuccess(id: string): Promise<void> {
    await this.enterpriseModel.updateOne({ _id: id }, { $set: { failedLogins: 0, lockUntil: null, lastLoginAt: new Date() } });
  }

  /** Código da verificação em duas etapas aceito: o e-mail é de quem diz ser. */
  async markEmailVerified(id: string): Promise<void> {
    await this.enterpriseModel.updateOne({ _id: id, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } });
  }

  // ---------------------------------------------------------------- login com Google

  findByGoogleId(googleId: string): Promise<EnterpriseDocument | null> {
    return this.enterpriseModel.findOne({ googleId }).select('+tokenVersion');
  }

  findByEmail(email: string): Promise<EnterpriseDocument | null> {
    return this.enterpriseModel.findOne({ email: email.trim().toLowerCase() }).select('+tokenVersion +googleId');
  }

  /**
   * Vincula a conta Google (o Google já confirmou o e-mail). Se o e-mail nunca tinha sido confirmado aqui,
   * derruba as sessões existentes: alguém pode ter criado a conta com o e-mail de outra pessoa antes dela.
   * A senha continua valendo, mas entrar com ela exige o código enviado ao e-mail (que é do dono de verdade).
   */
  async linkGoogle(e: EnterpriseDocument, googleId: string): Promise<EnterpriseDocument> {
    const wasVerified = !!e.emailVerifiedAt;
    const updated = await this.enterpriseModel.findOneAndUpdate(
      { _id: e._id, $or: [{ googleId: null }, { googleId: { $exists: false } }] },
      { $set: { googleId, emailVerifiedAt: e.emailVerifiedAt ?? new Date(), lastLoginAt: new Date() }, ...(wasVerified ? {} : { $inc: { tokenVersion: 1 } }) },
      { returnDocument: 'after' },
    ).select('+tokenVersion');
    if (!updated) throw new ConflictException('Esta conta já está vinculada a outra conta Google');
    return updated;
  }

  /** Cadastro pelo Google: sem senha própria (fica um hash aleatório; dá para criar uma pelo "esqueci a senha"). */
  async createWithGoogle(p: { name: string; email: string; googleId: string; cnpj?: string }, terms: { version: string; privacyVersion?: string | null }): Promise<EnterpriseDocument> {
    const password = await bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_COST);
    const { trialDays } = await this.settings.policy();
    try {
      const created = await this.enterpriseModel.create({
        name: p.name, email: p.email.trim().toLowerCase(), password, cnpj: p.cnpj, googleId: p.googleId, emailVerifiedAt: new Date(), lastLoginAt: new Date(),
        trialEndsAt: new Date(Date.now() + trialDays * 24 * 3600_000),
        termsAcceptedAt: new Date(), termsVersion: terms.version, privacyVersion: terms.privacyVersion ?? null,
      });
      await this.legal?.logConsent({ kind: 'enterprise', subjectId: String(created._id), email: created.email, termsVersion: terms.version, privacyVersion: terms.privacyVersion, event: 'register' });
      return created;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe uma empresa com esse e-mail. Entre com a senha ou com o Google.');
      throw e;
    }
  }

  async setResetToken(email: string, hash: string, expires: Date): Promise<EnterpriseDocument | null> {
    return this.enterpriseModel.findOneAndUpdate(
      { email: email.trim().toLowerCase(), status: 'active' },
      { $set: { passwordResetHash: hash, passwordResetExpires: expires } },
      { returnDocument: 'after' },
    );
  }

  /** Consome o token (uso único) e define a senha nova; derruba sessões antigas. */
  async resetPasswordByHash(hash: string, newPassword: string): Promise<boolean> {
    const updated = await this.enterpriseModel.findOneAndUpdate(
      { passwordResetHash: hash, passwordResetExpires: { $gt: new Date() }, status: 'active' },
      {
        $set: { password: await bcrypt.hash(newPassword, BCRYPT_COST), passwordResetHash: null, passwordResetExpires: null, failedLogins: 0, lockUntil: null },
        $inc: { tokenVersion: 1 },
      },
    );
    return !!updated;
  }

  /** Cria o administrador na subida (ADMIN_EMAIL/ADMIN_PASSWORD). Nunca altera senha de conta existente. */
  async ensureAdmin(email: string, password: string): Promise<void> {
    const e = email.trim().toLowerCase();
    const existing = await this.enterpriseModel.findOne({ email: e });
    if (existing) {
      if (existing.role !== 'admin') {
        await this.enterpriseModel.updateOne({ _id: existing._id }, { $set: { role: 'admin' } });
        this.logger.warn(`Conta ${e} promovida a administrador (ADMIN_EMAIL)`);
      }
      return;
    }
    await this.enterpriseModel.create({ name: 'Administrador', email: e, password: await bcrypt.hash(password, BCRYPT_COST), role: 'admin' });
    this.logger.log(`Administrador ${e} criado`);
  }

  // ---------------------------------------------------------------- cobrança

  /** Escreve no documento da empresa: vendas simultâneas conflitam aqui e a transação repete uma delas. */
  lockForBilling(id: string, session: ClientSession) {
    return this.enterpriseModel.findOneAndUpdate({ _id: id }, { $inc: { debtCents: 0 } }, { session, returnDocument: 'after' });
  }

  async addDebt(id: string, deltaCents: number, session?: ClientSession): Promise<void> {
    await this.enterpriseModel.updateOne({ _id: id }, { $inc: { debtCents: deltaCents } }, { session });
  }

  async setBlocked(id: string, blocked: boolean, session?: ClientSession): Promise<void> {
    if (blocked) {
      await this.enterpriseModel.updateOne(
        { _id: id, 'billing.status': { $ne: 'blocked' } },
        { $set: { 'billing.status': 'blocked', 'billing.blockedAt': new Date() } },
        { session },
      );
    } else {
      await this.enterpriseModel.updateOne(
        { _id: id },
        { $set: { 'billing.status': 'active', 'billing.blockedAt': null } },
        { session },
      );
    }
  }

  // ---------------------------------------------------------------- admin

  async acceptTerms(id: string, termsVersion: string, privacyVersion: string): Promise<EnterpriseDocument> {
    const e = await this.enterpriseModel.findByIdAndUpdate(id, { $set: { termsAcceptedAt: new Date(), termsVersion, privacyVersion } }, { new: true });
    if (!e) throw new NotFoundException('Empresa não encontrada');
    await this.legal?.logConsent({ kind: 'enterprise', subjectId: id, email: e.email, termsVersion, privacyVersion, event: 'accept' });
    return e;
  }

  async adminPatch(id: string, patch: { suspended?: boolean; suspendedReason?: string; feeExempt?: boolean; trialEndsAt?: Date; feeCapCents?: number | null }): Promise<EnterpriseDocument> {
    const set: Record<string, unknown> = {};
    const inc: Record<string, number> = {};
    if (patch.suspended === true) { set.status = 'suspended'; set.suspendedAt = new Date(); set.suspendedReason = patch.suspendedReason ?? null; inc.tokenVersion = 1; }
    if (patch.suspended === false) { set.status = 'active'; set.suspendedAt = null; set.suspendedReason = null; }
    if (patch.feeExempt !== undefined) set.feeExempt = patch.feeExempt;
    if (patch.trialEndsAt) set.trialEndsAt = patch.trialEndsAt;
    if (patch.feeCapCents !== undefined) set.feeCapCents = patch.feeCapCents;
    const updated = await this.enterpriseModel.findOneAndUpdate({ _id: id }, { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) }, { returnDocument: 'after' });
    if (!updated) throw new NotFoundException('Empresa não encontrada');
    return updated;
  }
}
