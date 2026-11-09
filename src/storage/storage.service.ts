import { BadRequestException, Injectable, Logger, NotFoundException, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, createHmac } from 'crypto';
import { Model, Types } from 'mongoose';
import { join } from 'path';
import { LocalDriver, R2Driver, type StorageDriver } from './storage.driver';
import {
  IMAGE_QUOTA_BYTES, KINDS, PRESIGN_TTL_SECONDS, VIDEO_QUOTA_BYTES, acceptedType, isVideoKind, keyFromUrl, newKey, ownsKey, parseDataUrl, sniffFile,
  type FileType, type UploadKind,
} from './storage.rules';
import { Upload } from './upload.schema';
import { masterKey, specOf, variantKey } from './image.rules';
import { optimizeImage } from './image';
import { crossTenant } from '../common/security/tenant-guard.plugin';

type Owner = string | null; // id da empresa, ou null = plataforma
const oid = (o: Owner) => (o ? new Types.ObjectId(o) : null);
const MB = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;
const family = (t: string) => t.split('/')[0];

/** Escolhe o armazenamento: R2 com as variáveis; senão (só fora de produção) a pasta local .uploads. */
export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL) {
    return new R2Driver({ accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_BUCKET, publicUrl: env.R2_PUBLIC_URL });
  }
  if (env.NODE_ENV === 'production') throw new Error('Cloudflare R2 não configurado');
  const secret = createHmac('sha256', env.JWT_SECRET ?? 'dev').update('storage-local').digest('hex');
  // Endereço da própria API em desenvolvimento. Não usa APP_URL: ali costuma estar a URL pública (https),
  // e a API local responde em http. STORAGE_LOCAL_URL troca (ex.: http://192.168.0.10:2700 para testar no celular).
  return new LocalDriver(join(process.cwd(), '.uploads'), env.STORAGE_LOCAL_URL || `http://localhost:${env.PORT ?? 2700}`, secret);
}

/**
 * Arquivos das empresas (fotos, logo, banners, favicon, vídeos) no Cloudflare R2.
 * O navegador/app manda o arquivo direto para o R2 por uma URL assinada e curta; a API só guarda a URL.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger('Storage');
  readonly driver: StorageDriver;
  constructor(@InjectModel(Upload.name) private readonly uploads: Model<Upload>) {
    this.driver = driverFromEnv();
    if (this.driver.name === 'local') this.log.warn('R2 não configurado: arquivos numa pasta local (.uploads), só para desenvolvimento.');
  }

  url(key: string) { return `${this.driver.publicBase}/${key}`; }
  keyOf(url: string) { return keyFromUrl(this.driver.publicBase, url); }
  /** URL nossa (do R2/pasta local), e não um link externo. */
  isOurs(url: string | null | undefined) { return !!url && !!this.keyOf(url); }

  /** Espaço usado (pendentes recentes contam: reservam a cota até expirar). */
  async usage(owner: Owner, video: boolean) {
    const kinds = Object.keys(KINDS).filter((k) => isVideoKind(k as UploadKind) === video);
    const [r] = await this.uploads.aggregate<{ used: number }>([
      { $match: { enterpriseId: oid(owner), kind: { $in: kinds }, $or: [{ status: { $ne: 'pending' } }, { createdAt: { $gt: new Date(Date.now() - 3600_000) } }] } },
      { $group: { _id: null, used: { $sum: '$size' } } },
    ]);
    return r?.used ?? 0;
  }

  private async checkQuota(owner: Owner, kind: UploadKind, size: number) {
    if (!owner) return;
    const video = isVideoKind(kind);
    const quota = video ? VIDEO_QUOTA_BYTES : IMAGE_QUOTA_BYTES;
    if ((await this.usage(owner, video)) + size > quota) {
      throw new PayloadTooLargeException({ statusCode: 413, code: 'STORAGE_QUOTA', message: video ? `Espaço de vídeos cheio (${MB(quota)}). Apague vídeos que não usa mais.` : `Espaço de imagens cheio (${MB(quota)}). Apague fotos e produtos que não usa mais.` });
    }
  }

  private checkFile(kind: UploadKind, type: string, size: number): asserts type is FileType {
    const k = KINDS[kind];
    if (!acceptedType(kind, type)) throw new BadRequestException({ statusCode: 400, code: 'FILE_TYPE', message: isVideoKind(kind) ? 'Formato não aceito. Envie MP4, WEBM ou MOV.' : kind === 'favicon' ? 'Use uma imagem PNG, ICO ou WebP.' : 'Use uma imagem PNG, JPG ou WebP.' });
    if (!Number.isInteger(size) || size <= 0) throw new BadRequestException('Arquivo vazio');
    if (size > k.maxBytes) throw new PayloadTooLargeException({ statusCode: 413, code: 'FILE_TOO_LARGE', message: `Arquivo maior que ${k.maxBytes >= 1024 * 1024 ? MB(k.maxBytes) : `${Math.round(k.maxBytes / 1024)} KB`}.` });
  }

  /** 1º passo: URL de envio direto, válida por 5 minutos, para um arquivo com tipo e tamanho exatos. */
  async presign(owner: Owner, kind: UploadKind, type: string, size: number, name = '') {
    this.checkFile(kind, type, size);
    await this.checkQuota(owner, kind, size);
    const key = newKey(owner, kind, type);
    const up = await this.uploads.create({ enterpriseId: oid(owner), key, kind, contentType: type, size, status: 'pending', name: name.replace(/[^\w.\- ]+/g, '').slice(0, 80) });
    const put = await this.driver.presignPut(key, type, size, PRESIGN_TTL_SECONDS);
    return { id: String(up._id), method: 'PUT' as const, url: put.url, headers: put.headers, key, publicUrl: this.url(key), expiresIn: PRESIGN_TTL_SECONDS };
  }

  /** 2º passo: o arquivo chegou? Confere tamanho e a assinatura real (não o tipo que o navegador disse). */
  async complete(id: string, may: (owner: Owner) => boolean) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Envio não encontrado');
    const up = await this.uploads.findById(id);
    if (!up || !may(up.enterpriseId ? String(up.enterpriseId) : null)) throw new NotFoundException('Envio não encontrado');
    if (up.status !== 'pending') return this.present(up);
    const reject = async (message: string) => {
      await this.driver.remove([up.key]).catch(() => {});
      await up.deleteOne();
      throw new UnprocessableEntityException({ statusCode: 422, code: 'FILE_REJECTED', message });
    };
    const head = await this.driver.head(up.key);
    if (!head) throw new UnprocessableEntityException({ statusCode: 422, code: 'FILE_MISSING', message: 'O arquivo ainda não chegou. Tente enviar de novo.' });
    if (head.size !== up.size) return reject('O arquivo enviado não é o mesmo que foi anunciado.');
    const real = sniffFile(await this.driver.readStart(up.key, 16));
    if (!real || family(real) !== family(up.contentType) || !acceptedType(up.kind as UploadKind, real)) return reject(isVideoKind(up.kind as UploadKind) ? 'Formato não aceito. Envie MP4, WEBM ou MOV.' : 'O arquivo não é uma imagem PNG, JPG ou WebP de verdade.');
    up.contentType = real;
    const spec = specOf(up.kind as UploadKind);
    if (spec && family(real) === 'image') {
      // Imagem: leve e bonita (gira pela câmera, tira EXIF/GPS, limita o tamanho, WebP, versões menores).
      let done: Awaited<ReturnType<StorageService['store']>>;
      try { done = await this.store(up.kind as UploadKind, up.key, await this.driver.read(up.key)); }
      catch (e) { this.log.warn(`imagem recusada (${up.key}): ${(e as Error).message}`); return reject('A imagem está corrompida ou não abre. Tente outra.'); }
      if (done.key !== up.key) await this.driver.remove([up.key]).catch(() => {});
      Object.assign(up, { key: done.key, contentType: 'image/webp', size: done.size, variants: done.variants });
    }
    up.status = isVideoKind(up.kind as UploadKind) ? 'attached' : 'ready'; // vídeo vai para a biblioteca da loja
    await up.save();
    return this.present(up);
  }

  /**
   * Otimiza a imagem e grava o original otimizado e as versões menores. Devolve a chave final (o nome diz quais versões
   * existem, ver image.rules.ts), o tamanho somado (conta na cota) e as chaves das versões.
   */
  private async store(kind: UploadKind, key: string, data: Buffer) {
    const spec = specOf(kind)!;
    const o = await optimizeImage(data, spec);
    const master = masterKey(key, o.variants.map((v) => v.width));
    if (master !== key || !o.kept) await this.driver.put(master, o.master, 'image/webp');
    const variants: string[] = [];
    for (const v of o.variants) { const k = variantKey(master, v.width); await this.driver.put(k, v.data, 'image/webp'); variants.push(k); }
    return { key: master, size: o.master.length + o.variants.reduce((n, v) => n + v.data.length, 0), variants };
  }

  /** Chaves de um registro de envio, com as versões menores. */
  private static allKeys(rows: { key: string; variants?: string[] }[]) { return rows.flatMap((r) => [r.key, ...(r.variants ?? [])]); }

  present(u: Pick<Upload, 'key' | 'kind' | 'contentType' | 'size' | 'name'> & { _id: unknown; createdAt?: Date }) {
    return { id: String(u._id), url: this.url(u.key), key: u.key, kind: u.kind, contentType: u.contentType, size: u.size, name: u.name, createdAt: u.createdAt };
  }

  /**
   * Sobe bytes de uma vez (imagens base64 antigas, clientes antigos e a migração).
   * Mesmo conteúdo da mesma empresa vira o mesmo arquivo: rodar de novo não duplica.
   */
  async ingest(owner: Owner, kind: UploadKind, data: Buffer, opts: { legacy?: string; name?: string; skipQuota?: boolean } = {}) {
    const type = sniffFile(data);
    if (!type) throw new BadRequestException({ statusCode: 400, code: 'FILE_TYPE', message: 'Arquivo não reconhecido' });
    this.checkFile(kind, type, data.length);
    const legacy = opts.legacy ?? `sha256:${createHash('sha256').update(data).digest('hex')}`;
    const same = await this.uploads.findOne({ enterpriseId: oid(owner), legacy });
    if (same && (await this.driver.head(same.key))) {
      if (same.status !== 'attached') await same.updateOne({ status: 'attached' });
      return this.present(same);
    }
    if (same) await same.deleteOne(); // registro sem arquivo (envio interrompido): sobe de novo
    if (!opts.skipQuota) await this.checkQuota(owner, kind, data.length); // a migração não barra pela cota: os arquivos já existiam
    let key = newKey(owner, kind, type); let size = data.length; let contentType: string = type; let variants: string[] = [];
    if (specOf(kind) && family(type) === 'image') {
      const done = await this.store(kind, key, data).catch(() => { throw new BadRequestException({ statusCode: 400, code: 'FILE_TYPE', message: 'A imagem está corrompida ou não abre' }); });
      ({ key, size, variants } = done); contentType = 'image/webp';
    } else await this.driver.put(key, data, type);
    const up = await this.uploads.create({ enterpriseId: oid(owner), key, kind, contentType, size, variants, status: 'attached', legacy, name: (opts.name ?? '').slice(0, 80) });
    return this.present(up);
  }

  /**
   * O que vai ser salvo num campo de imagem/vídeo:
   * - '' fica ''; data: (cliente antigo) sobe para o R2 e vira URL;
   * - URL nossa: precisa ser desta empresa e ter sido enviada de verdade (marca como em uso);
   * - link https externo continua aceito (como antes); `media:<id>` (vídeo antigo no GridFS) também.
   */
  async resolve(owner: Owner, kind: UploadKind, value: string | null | undefined): Promise<string> {
    const v = (value ?? '').trim();
    if (!v) return '';
    if (v.startsWith('data:')) {
      const p = parseDataUrl(v);
      if (!p) throw new BadRequestException('Imagem inválida');
      return (await this.ingest(owner, kind, p.data)).url;
    }
    const key = this.keyOf(v);
    if (key) {
      if (!ownsKey(owner, key)) throw new BadRequestException({ statusCode: 400, code: 'FILE_NOT_OWNED', message: 'Este arquivo não é desta empresa' });
      const up = await this.uploads.findOneAndUpdate({ key, enterpriseId: oid(owner), status: { $in: ['ready', 'attached'] } }, { $set: { status: 'attached' } });
      if (!up) throw new BadRequestException({ statusCode: 400, code: 'FILE_NOT_READY', message: 'O envio do arquivo não terminou. Escolha o arquivo de novo.' });
      return this.url(key);
    }
    if (/^media:[a-f0-9]{24}$/.test(v) && isVideoKind(kind)) return v;
    if (/^https:\/\/[^\s"'<>]+$/.test(v)) return v;
    throw new BadRequestException('Endereço de arquivo inválido');
  }

  resolveMany(owner: Owner, kind: UploadKind, values: (string | null | undefined)[]) {
    return Promise.all(values.map((v) => this.resolve(owner, kind, v)));
  }

  /** Apaga do R2 os arquivos nossos (e só os desta empresa) que deixaram de ser usados. Falha não trava o salvamento. */
  async release(owner: Owner, urls: (string | null | undefined)[]) {
    const keys = [...new Set(urls.map((u) => (u ? this.keyOf(u) : null)).filter((k): k is string => !!k && ownsKey(owner, k)))];
    if (!keys.length) return;
    try {
      const rows = await this.uploads.find({ key: { $in: keys }, enterpriseId: oid(owner) }).select('key variants').lean();
      await this.driver.remove([...new Set([...keys, ...StorageService.allKeys(rows)])]);
      await this.uploads.deleteMany({ key: { $in: keys }, enterpriseId: oid(owner) });
    } catch (e) { this.log.error(`Não foi possível apagar ${keys.length} arquivo(s): ${(e as Error).message}`); }
  }

  /** Empresa excluída: apaga a pasta inteira dela. */
  async purgeOwner(owner: string) {
    const rows = await this.uploads.find({ enterpriseId: oid(owner) }).select('key variants').lean();
    await this.driver.remove(StorageService.allKeys(rows));
    await this.uploads.deleteMany({ enterpriseId: oid(owner) });
    return rows.length;
  }

  /** Vídeos da biblioteca da loja. */
  async videos(owner: string) {
    const rows = await this.uploads.find({ enterpriseId: oid(owner), kind: 'video', status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(100).lean();
    return rows.map((r) => this.present(r as never));
  }
  async removeVideo(owner: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Vídeo não encontrado');
    const up = await this.uploads.findOne({ _id: id, enterpriseId: oid(owner), kind: 'video' }).lean();
    if (!up) throw new NotFoundException('Vídeo não encontrado');
    await this.release(owner, [this.url(up.key)]);
    return { deleted: true };
  }

  /** Vídeo antigo do GridFS que a migração já subiu: o endereço novo. */
  async migratedVideo(gridId: string) {
    const up = await this.uploads.findOne({ legacy: `gridfs:${gridId}` }).select('key').lean();
    return up ? this.url(up.key) : null;
  }

  /** Limpeza: envios que nunca terminaram (1 h) e arquivos enviados mas nunca usados (24 h). */
  async cleanup() {
    const rows = await crossTenant(this.uploads, 'rotina: limpa envios abandonados de todas as lojas').find({ $or: [{ status: 'pending', createdAt: { $lt: new Date(Date.now() - 3600_000) } }, { status: 'ready', updatedAt: { $lt: new Date(Date.now() - 24 * 3600_000) } }] }).limit(1000).select('key variants').lean();
    if (!rows.length) return 0;
    await this.driver.remove(StorageService.allKeys(rows));
    await crossTenant(this.uploads, 'rotina: limpa envios abandonados de todas as lojas').deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    return rows.length;
  }
}
