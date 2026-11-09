import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join, normalize } from 'path';

/** O que o resto do sistema precisa de um armazenamento de arquivos. */
export interface StorageDriver {
  readonly name: 'r2' | 'local';
  /** Endereço público base: URL do arquivo = `${publicBase}/${key}`. */
  readonly publicBase: string;
  /** URL de envio direto (PUT), assinada, com tipo e tamanho exatos. */
  presignPut(key: string, type: string, size: number, ttlSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  head(key: string): Promise<{ size: number } | null>;
  /** Primeiros `n` bytes (para conferir a assinatura do arquivo). */
  readStart(key: string, n: number): Promise<Buffer>;
  /** Arquivo inteiro (para otimizar imagens depois do envio). */
  read(key: string): Promise<Buffer>;
  put(key: string, data: Buffer, type: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const IMMUTABLE = 'public, max-age=31536000, immutable'; // a chave nunca é reaproveitada: o arquivo pode ficar em cache para sempre

/** Cloudflare R2 pela API compatível com S3. */
export class R2Driver implements StorageDriver {
  readonly name = 'r2' as const;
  readonly publicBase: string;
  private readonly s3: S3Client;
  constructor(private readonly cfg: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicUrl: string }) {
    this.publicBase = cfg.publicUrl.replace(/\/+$/, '');
    this.s3 = new S3Client({ region: 'auto', endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  }
  async presignPut(key: string, type: string, size: number, ttlSeconds: number) {
    const cmd = new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: type, ContentLength: size });
    // Tipo e tamanho entram na assinatura: o navegador não consegue mandar outro tipo nem um arquivo maior.
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) });
    return { url, headers: { 'Content-Type': type } };
  }
  async head(key: string) {
    try { const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key })); return { size: r.ContentLength ?? 0 }; }
    catch (e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async readStart(key: string, n: number) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range: `bytes=0-${n - 1}` }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async read(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async put(key: string, data: Buffer, type: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: data, ContentType: type, CacheControl: IMMUTABLE }));
  }
  async remove(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const part = keys.slice(i, i + 1000);
      if (part.length) await this.s3.send(new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: part.map((Key) => ({ Key })), Quiet: true } }));
    }
  }
}

/**
 * Só desenvolvimento (sem as variáveis do R2): arquivos numa pasta local, servidos pela própria API.
 * O envio continua "direto" e assinado (PUT em /storage/local/<token>), igual ao fluxo do R2.
 */
export class LocalDriver implements StorageDriver {
  readonly name = 'local' as const;
  readonly publicBase: string;
  constructor(private readonly root: string, private readonly apiUrl: string, private readonly secret: string) {
    this.publicBase = `${apiUrl.replace(/\/+$/, '')}/storage/files`;
  }
  private path(key: string) {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('Chave inválida');
    return p;
  }
  private sign(payload: string) { return createHmac('sha256', this.secret).update(payload).digest('base64url'); }
  async presignPut(key: string, type: string, size: number, ttlSeconds: number) {
    const payload = Buffer.from(JSON.stringify({ key, type, size, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
    return { url: `${this.apiUrl.replace(/\/+$/, '')}/storage/local/${payload}.${this.sign(payload)}`, headers: { 'Content-Type': type } };
  }
  /** Confere o token do PUT local: assinatura, validade, tipo e tamanho. */
  verifyPut(token: string, type: string | undefined, size: number): { key: string } | null {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(this.sign(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { key: string; type: string; size: number; exp: number };
    if (t.exp < Date.now() || t.type !== type || t.size !== size) return null;
    return { key: t.key };
  }
  async head(key: string) { try { return { size: (await fs.stat(this.path(key))).size }; } catch { return null; } }
  async readStart(key: string, n: number) {
    const fh = await fs.open(this.path(key), 'r');
    try { const buf = Buffer.alloc(n); const { bytesRead } = await fh.read(buf, 0, n, 0); return buf.subarray(0, bytesRead); } finally { await fh.close(); }
  }
  async read(key: string) { return fs.readFile(this.path(key)); }
  async put(key: string, data: Buffer) { const p = this.path(key); await fs.mkdir(dirname(p), { recursive: true }); await fs.writeFile(p, data); }
  async remove(keys: string[]) { await Promise.all(keys.map((k) => fs.rm(this.path(k), { force: true }))); }
  filePath(key: string) { return this.path(key); }
}
