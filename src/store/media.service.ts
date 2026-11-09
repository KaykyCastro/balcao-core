import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, mongo } from 'mongoose';
import { StorageService } from '../storage/storage.service';
import { VIDEO_QUOTA_BYTES, KINDS } from '../storage/storage.rules';

/** Até 40 MB por vídeo e 400 MB por empresa (uns 15 a 30 vídeos curtos de vitrine). Valores em storage.rules.ts. */
export const MEDIA_MAX_BYTES = KINDS.video.maxBytes;
export const MEDIA_QUOTA_BYTES = VIDEO_QUOTA_BYTES;
const TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
export type MediaType = (typeof TYPES)[number];

/** Confere a assinatura do arquivo (não confia no tipo que o navegador diz). */
export function sniffVideo(buf: Buffer): MediaType | null {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return buf.toString('latin1', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  return null;
}

/** Intervalo pedido pelo player (`Range: bytes=a-b`). Sem cabeçalho = arquivo inteiro. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number, end: number;
  if (!m[1]) { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; } // últimos n bytes
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export interface MediaInfo { id: string; url: string; ref: string; contentType: string; size: number; name: string; createdAt: Date }

/**
 * Vídeos da vitrine. Novos: Cloudflare R2, enviados direto pelo navegador (uploads/presign, kind 'video').
 * Antigos: GridFS, até a migração (scripts/migrate-r2.js) subir para o R2; depois o endereço antigo redireciona.
 */
@Injectable()
export class MediaService {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly storage: StorageService) {}

  private get bucket() { return new mongo.GridFSBucket(this.connection.db!, { bucketName: 'media' }); }
  private get files() { return this.connection.db!.collection('media.files'); }

  private legacy(f: { _id: unknown; length: number; filename: string; uploadDate: Date; metadata?: { contentType?: string } }): MediaInfo {
    const id = String(f._id);
    return { id, url: `/public/media/${id}`, ref: `media:${id}`, contentType: f.metadata?.contentType ?? 'video/mp4', size: f.length, name: f.filename, createdAt: f.uploadDate };
  }

  async list(enterpriseId: string) {
    const fresh = (await this.storage.videos(enterpriseId)).map((v): MediaInfo => ({ id: v.id, url: v.url, ref: v.url, contentType: v.contentType, size: v.size, name: v.name, createdAt: v.createdAt ?? new Date() }));
    const old = await this.files.find({ 'metadata.enterpriseId': new Types.ObjectId(enterpriseId) }).sort({ uploadDate: -1 }).limit(100).toArray();
    const pending: MediaInfo[] = [];
    for (const f of old) if (!(await this.storage.migratedVideo(String(f._id)))) pending.push(this.legacy(f as never));
    const items = [...fresh, ...pending];
    const used = (await this.storage.usage(enterpriseId, true)) + pending.reduce((s, r) => s + r.size, 0);
    return { items, usedBytes: used, quotaBytes: MEDIA_QUOTA_BYTES, maxBytes: MEDIA_MAX_BYTES };
  }

  async remove(enterpriseId: string, id: string) {
    const _id = new Types.ObjectId(id);
    const f = await this.files.findOne({ _id, 'metadata.enterpriseId': new Types.ObjectId(enterpriseId) });
    if (!f) return this.storage.removeVideo(enterpriseId, id); // vídeo no R2
    await this.bucket.delete(_id);
    return { deleted: true };
  }

  /** Para o player: vídeo já migrado vira redirecionamento; senão, metadados + stream do trecho pedido (GridFS). */
  async open(id: string, range?: string) {
    const moved = await this.storage.migratedVideo(id);
    if (moved) return { status: 302 as const, location: moved };
    const _id = new Types.ObjectId(id);
    const f = await this.files.findOne({ _id });
    if (!f) throw new NotFoundException('Vídeo não encontrado');
    const size = f.length as number;
    const r = parseRange(range, size);
    const type = (f.metadata?.contentType as string) ?? 'video/mp4';
    if (r === 'invalid') return { status: 416 as const, size, type };
    const start = r?.start ?? 0, end = r?.end ?? size - 1;
    const stream = this.bucket.openDownloadStream(_id, { start, end: end + 1 });
    return { status: r ? (206 as const) : (200 as const), size, type, start, end, stream };
  }
}
