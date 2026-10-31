import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';
import * as bcrypt from 'bcrypt';

import { EnterpriseSchema, EnterpriseDocument } from './schema/enterprise.schema';
import { EnterpriseCreateDto } from './dto/enterprise-create.dto';
import { EnterpriseUpdateDto } from './dto/enterprise.update.dto';
import { isDuplicateKeyError } from '../common/mongo';
import { SettingsService } from '../settings/settings.service';

export const BCRYPT_COST = 12;
/** Hash descartável para gastar o mesmo tempo quando o e-mail não existe (evita descobrir e-mails pelo tempo de resposta). */
export const DUMMY_HASH = bcrypt.hashSync('senha-que-nunca-sera-usada', BCRYPT_COST);

/** Coleções com dados da empresa apagadas junto com a conta. Faturas e razão de taxas ficam (registro financeiro). */
const TENANT_MODELS = ['ProductSchema', 'CategorySchema', 'CustomerSchema', 'CustomerPayment', 'Sale'];

@Injectable()
export class EnterpriseService {
  private readonly logger = new Logger(EnterpriseService.name);

  constructor(
    @InjectModel(EnterpriseSchema.name) private readonly enterpriseModel: Model<EnterpriseSchema>,
    @InjectConnection() private readonly connection: Connection,
    private readonly settings: SettingsService,
  ) {}

  async create(dto: EnterpriseCreateDto, terms?: { version: string }): Promise<EnterpriseDocument> {
    const email = dto.email.trim().toLowerCase();
    if (await this.enterpriseModel.exists({ email })) throw new ConflictException('Já existe uma empresa com esse e-mail');
    const password = await bcrypt.hash(dto.password, BCRYPT_COST);
    const { trialDays } = await this.settings.policy(); // 0 = sem teste grátis
    try {
      // Campos explícitos: impede injetar role/debtCents/billing/trial pelo body.
      return await this.enterpriseModel.create({
        name: dto.name, logo: dto.logo, email, password, cnpj: dto.cnpj,
        trialEndsAt: new Date(Date.now() + trialDays * 24 * 3600_000),
        ...(terms ? { termsAcceptedAt: new Date(), termsVersion: terms.version } : {}),
      });
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
    if (dto.logo !== undefined) set.logo = dto.logo;
    if (dto.cnpj !== undefined) set.cnpj = dto.cnpj;
    if (changesEmail) set.email = newEmail;
    const update: Record<string, unknown> = { $set: set };
    if (dto.password !== undefined) {
      set.password = await bcrypt.hash(dto.password, BCRYPT_COST);
      update.$inc = { tokenVersion: 1 }; // derruba as outras sessões
    }

    try {
      const updated = await this.enterpriseModel.findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true });
      if (!updated) throw new NotFoundException('Empresa não encontrada');
      return updated;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Já existe uma empresa com esse e-mail');
      throw e;
    }
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

  /** Exclui a conta e os dados dela. Exige a senha e nenhuma taxa em aberto. */
  async delete(id: string, password: string): Promise<void> {
    const enterprise = await this.enterpriseModel.findById(id).select('+password');
    if (!enterprise) throw new NotFoundException('Empresa não encontrada');
    if (enterprise.role === 'admin') throw new ForbiddenException('Contas de administrador não podem ser excluídas por aqui');
    if (!(await bcrypt.compare(password, enterprise.password))) throw new ForbiddenException('Senha incorreta');
    if ((enterprise.debtCents ?? 0) > 0) throw new ConflictException('Existe taxa do ERP em aberto. Quite antes de excluir a conta.');

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const name of TENANT_MODELS) {
          const model = this.connection.models[name];
          if (model) await model.deleteMany({ enterpriseId: enterprise._id }, { session });
        }
        await this.enterpriseModel.deleteOne({ _id: enterprise._id }, { session });
      });
    } finally {
      await session.endSession();
    }
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
