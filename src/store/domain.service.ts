import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { promises as dns } from 'dns';
import { Model, Types } from 'mongoose';
import { crossTenant } from '../common/security/tenant-guard.plugin';
import { DOMAIN_TXT_PREFIX, DomainError, domainToken, hostKey, normalizeDomain, pointsToUs } from './domain.rules';
import { Store } from './schema/store.schema';

/**
 * Domínio próprio da loja. O lojista digita o domínio, configura dois registros no DNS (para onde aponta e o código
 * de confirmação) e clica em verificar. Ativo, a loja abre nele com HTTPS automático (o Caddy pergunta a `allow`
 * antes de emitir o certificado). Env: DOMAIN_TARGET_IPS (IPs do servidor, separados por vírgula) e/ou
 * DOMAIN_TARGET_HOST (nome para o CNAME, ex.: lojas.usebalcao.com).
 */
@Injectable()
export class DomainService {
  private readonly logger = new Logger('DominioProprio');
  private readonly all: Model<Store>;
  constructor(@InjectModel(Store.name) private readonly stores: Model<Store>, private readonly config: ConfigService) {
    this.all = crossTenant(stores, 'domínio próprio: achar a loja pelo endereço (vitrine e certificado)');
  }

  private get target() {
    const ips = (this.config.get<string>('DOMAIN_TARGET_IPS') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const host = (this.config.get<string>('DOMAIN_TARGET_HOST') ?? '').trim().toLowerCase();
    return { ips, host, ready: ips.length > 0 || !!host };
  }
  /** Domínios da própria plataforma (não podem ser de uma loja). */
  private get blocked() {
    const h = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
    return [h(this.config.get('FRONTEND_URL')), h(this.config.get('APP_URL')), this.target.host, ...(this.config.get<string>('DOMAIN_BLOCKED') ?? '').split(',')].map((x) => x.trim()).filter(Boolean);
  }
  private token(storeId: string, host: string) { return domainToken(this.config.getOrThrow<string>('JWT_SECRET'), storeId, host); }

  private async mine(eid: string) {
    const s = await this.stores.findOne({ enterpriseId: new Types.ObjectId(eid) });
    if (!s) throw new NotFoundException('Configure a loja online primeiro');
    return s;
  }

  /** O que a tela mostra: domínio, situação e os registros a criar no DNS. */
  async info(eid: string) {
    const s = await this.mine(eid);
    const t = this.target;
    const d = s.domain?.host ? s.domain : null;
    return {
      configured: t.ready,
      host: d?.host ?? null, status: d ? d.status : null, error: d?.error ?? '', checkedAt: d?.checkedAt ?? null, verifiedAt: d?.verifiedAt ?? null,
      records: d?.host ? [
        ...(t.ips.length ? t.ips.map((ip) => ({ type: ip.includes(':') ? 'AAAA' : 'A', name: '@', value: ip, why: 'Faz o domínio abrir a sua loja' })) : [{ type: 'CNAME', name: '@', value: t.host, why: 'Faz o domínio abrir a sua loja (se o seu provedor aceitar CNAME no domínio principal)' }]),
        ...(t.host ? [{ type: 'CNAME', name: 'www', value: t.host, why: 'Faz o www também abrir a loja' }] : t.ips.map((ip) => ({ type: ip.includes(':') ? 'AAAA' : 'A', name: 'www', value: ip, why: 'Faz o www também abrir a loja' }))),
        { type: 'TXT', name: DOMAIN_TXT_PREFIX, value: this.token(String(s._id), d.host), why: 'Confirma que o domínio é seu' },
      ] : [],
    };
  }

  async set(eid: string, raw: string) {
    if (!this.target.ready) throw new UnprocessableEntityException({ statusCode: 422, code: 'DOMAIN_UNAVAILABLE', message: 'Domínio próprio ainda não está disponível nesta instalação.' });
    let host: string;
    try { host = normalizeDomain(raw, this.blocked); } catch (e) { if (e instanceof DomainError) throw new UnprocessableEntityException({ statusCode: 422, code: 'DOMAIN_INVALID', message: e.message }); throw e; }
    const s = await this.mine(eid);
    const taken = await this.all.exists({ 'domain.host': host, 'domain.status': 'active', _id: { $ne: s._id } });
    if (taken) throw new ConflictException({ statusCode: 409, code: 'DOMAIN_TAKEN', message: 'Esse domínio já está ligado a outra loja.' });
    if (s.domain?.host !== host) await this.stores.updateOne({ _id: s._id, enterpriseId: s.enterpriseId }, { $set: { domain: { host, status: 'pending', verifiedAt: null, checkedAt: null, error: '' } } });
    return this.info(eid);
  }

  async remove(eid: string) {
    const s = await this.mine(eid);
    await this.stores.updateOne({ _id: s._id, enterpriseId: s.enterpriseId }, { $set: { domain: null } });
    return this.info(eid);
  }

  /** Confere o DNS agora: aponta para o Balcão e tem o código de confirmação? Os dois certos = ativo. */
  async verify(eid: string) {
    const s = await this.mine(eid);
    const host = s.domain?.host;
    if (!host) throw new UnprocessableEntityException('Digite o domínio primeiro');
    const [a, a6, cname, txt] = await Promise.all([
      dns.resolve4(host).catch(() => [] as string[]), dns.resolve6(host).catch(() => [] as string[]),
      dns.resolveCname(host).catch(() => [] as string[]), dns.resolveTxt(`${DOMAIN_TXT_PREFIX}.${host}`).catch(() => [] as string[][]),
    ]);
    const points = pointsToUs({ a: [...a, ...a6], cname }, this.target);
    const owned = txt.map((r) => r.join('')).includes(this.token(String(s._id), host));
    const problems = [!points && 'o domínio ainda não aponta para o Balcão (registro A ou CNAME)', !owned && `o registro TXT "${DOMAIN_TXT_PREFIX}" com o código de confirmação ainda não foi encontrado`].filter(Boolean) as string[];
    const now = new Date();
    if (problems.length) {
      const error = `Ainda não deu: ${problems.join(' e ')}. Mudanças no DNS podem levar de alguns minutos a algumas horas; tente de novo depois.`;
      await this.stores.updateOne({ _id: s._id, enterpriseId: s.enterpriseId }, { $set: { 'domain.checkedAt': now, 'domain.error': error, 'domain.status': s.domain?.status === 'active' && points ? 'active' : 'pending' } });
      return this.info(eid);
    }
    const taken = await this.all.exists({ 'domain.host': host, 'domain.status': 'active', _id: { $ne: s._id } });
    if (taken) throw new ConflictException({ statusCode: 409, code: 'DOMAIN_TAKEN', message: 'Esse domínio já está ligado a outra loja.' });
    await this.stores.updateOne({ _id: s._id, enterpriseId: s.enterpriseId }, { $set: { 'domain.status': 'active', 'domain.verifiedAt': s.domain?.verifiedAt ?? now, 'domain.checkedAt': now, 'domain.error': '' } });
    this.logger.log(`Domínio ${host} ativo na loja ${String(s._id)}`);
    return this.info(eid);
  }

  /** O Caddy pergunta antes de emitir o certificado: só domínios ativos (e o www deles). */
  async allow(raw: string): Promise<boolean> {
    const host = hostKey(raw);   // "www.minhaloja.com.br" e "minhaloja.com.br" → o mesmo domínio guardado
    if (!host || host.length > 200) return false;
    return !!(await this.all.exists({ 'domain.host': host, 'domain.status': 'active' }));
  }

  /** Vitrine aberta num domínio próprio: qual loja é. */
  async byHost(raw: string): Promise<{ slug: string; host: string }> {
    const host = hostKey(raw);
    const s = host ? await this.all.findOne({ 'domain.host': host, 'domain.status': 'active' }).select('slug').lean() : null;
    if (!s) throw new NotFoundException('Nenhuma loja neste endereço');
    return { slug: s.slug, host };
  }
}
