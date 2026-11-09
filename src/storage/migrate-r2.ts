import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { Connection, Model, Types, mongo } from 'mongoose';
import { validateEnv } from '../common/config/env';
import { EnterpriseSchema, EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { MarketBanner, MarketBannerSchema } from '../store/schema/market-banner.schema';
import { Store, StoreSchemaFactory } from '../store/schema/store.schema';
import { parseDataUrl, type UploadKind } from './storage.rules';
import { StorageService } from './storage.service';
import { Upload, UploadSchema } from './upload.schema';

/** Só o necessário para a migração (sem agendadores nem rotas). */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: (env) => { validateEnv(env as NodeJS.ProcessEnv); return env; } }),
    MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: (c: ConfigService) => ({ uri: c.get<string>('MONGO_URI') ?? c.get<string>('MONGO_DB'), autoIndex: true }) }),
    MongooseModule.forFeature([
      { name: Upload.name, schema: UploadSchema },
      { name: ProductSchema.name, schema: ProductSchemaFactory },
      { name: Store.name, schema: StoreSchemaFactory },
      { name: EnterpriseSchema.name, schema: EnterpriseSchemaFactory },
      { name: MarketBanner.name, schema: MarketBannerSchema },
    ]),
  ],
  providers: [StorageService],
})
export class MigrationModule {}

export interface MigrationReport { products: number; stores: number; enterprises: number; banners: number; videos: number; refs: number; gridfsDeleted: number; failures: string[] }

/**
 * Sobe para o R2 as imagens base64 e os vídeos do GridFS que ainda estão no banco, e troca pelos endereços novos.
 * Pode rodar quantas vezes quiser: só mexe no que ainda é base64/media:<id>, e o mesmo conteúdo vira o mesmo arquivo
 * (registro `legacy` em uploads). Cada documento só é alterado se o campo ainda for o valor antigo.
 */
export async function migrateToR2(app: INestApplicationContext, opts: { dry: boolean; deleteGridfs: boolean }, log = new Logger('MigracaoR2')): Promise<MigrationReport> {
  const storage = app.get(StorageService);
  const conn = app.get<Connection>(getConnectionToken());
  const products = app.get<Model<ProductSchema>>(getModelToken(ProductSchema.name)).collection;
  const stores = app.get<Model<Store>>(getModelToken(Store.name)).collection;
  const enterprises = app.get<Model<EnterpriseSchema>>(getModelToken(EnterpriseSchema.name)).collection;
  const banners = app.get<Model<MarketBanner>>(getModelToken(MarketBanner.name)).collection;
  const rep: MigrationReport = { products: 0, stores: 0, enterprises: 0, banners: 0, videos: 0, refs: 0, gridfsDeleted: 0, failures: [] };
  const DATA = /^data:/;
  const isData = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:');

  /** Um valor: base64 → URL no R2. Erro num arquivo não para a migração (fica como estava e entra no relatório). */
  const up = async (owner: string | null, kind: UploadKind, v: string, where: string) => {
    if (!isData(v)) return v;
    const p = parseDataUrl(v);
    if (!p) { rep.failures.push(`${where}: data URL inválida`); return v; }
    if (opts.dry) return 'https://(simulação)';
    try { return (await storage.ingest(owner, kind, p.data, { skipQuota: true })).url; }
    catch (e) { rep.failures.push(`${where}: ${(e as Error).message}`); return v; }
  };

  // 1) Vídeos do GridFS (antes das lojas, que apontam para eles com media:<id>).
  const files = conn.db!.collection('media.files');
  const bucket = new mongo.GridFSBucket(conn.db!, { bucketName: 'media' });
  const moved = new Map<string, string>();
  for await (const f of files.find({})) {
    const id = String(f._id);
    const done = await storage.migratedVideo(id);
    if (done) { moved.set(id, done); continue; }
    if (opts.dry) { rep.videos++; moved.set(id, 'https://(simulação)'); continue; }
    const owner = f.metadata?.enterpriseId ? String(f.metadata.enterpriseId) : null;
    if (!owner) { rep.failures.push(`vídeo ${id}: sem empresa`); continue; }
    try {
      const chunks: Buffer[] = [];
      for await (const c of bucket.openDownloadStream(f._id)) chunks.push(c as Buffer);
      const r = await storage.ingest(owner, 'video', Buffer.concat(chunks), { legacy: `gridfs:${id}`, name: String(f.filename ?? ''), skipQuota: true });
      moved.set(id, r.url); rep.videos++;
    } catch (e) { rep.failures.push(`vídeo ${id}: ${(e as Error).message}`); }
  }
  const ref = (v: unknown) => { const m = typeof v === 'string' ? /^media:([a-f0-9]{24})$/.exec(v) : null; return m && moved.get(m[1]) ? moved.get(m[1])! : v; };

  // 2) Produtos: capa e fotos.
  for await (const p of products.find({ $or: [{ image: DATA }, { images: DATA }] })) {
    const owner = String(p.enterpriseId);
    const images: string[] = [];
    for (const [i, v] of ((p.images as string[] | undefined)?.length ? (p.images as string[]) : p.image ? [p.image as string] : []).entries()) images.push(await up(owner, 'product', v, `produto ${p._id} foto ${i + 1}`));
    rep.products++;
    if (!opts.dry) await products.updateOne({ _id: p._id, image: p.image, images: p.images }, { $set: { images, image: images[0] ?? '' } });
  }

  // 3) Lojas: logo, banner, favicon, banners deslizantes; e vídeos media:<id> → URL.
  for await (const s of stores.find({ $or: [{ logo: DATA }, { banner: DATA }, { 'seo.favicon': DATA }, { 'slides.image': DATA }, { 'slides.video': /^media:/ }, { 'reels.video': /^media:/ }] })) {
    const owner = String(s.enterpriseId);
    const set: Record<string, unknown> = {};
    if (isData(s.logo)) set.logo = await up(owner, 'store', s.logo, `loja ${s.slug} logo`);
    if (isData(s.banner)) set.banner = await up(owner, 'store', s.banner, `loja ${s.slug} banner`);
    if (isData(s.seo?.favicon)) set['seo.favicon'] = await up(owner, 'favicon', s.seo.favicon, `loja ${s.slug} favicon`);
    const slides = (s.slides ?? []) as { image?: string; video?: string }[];
    if (slides.some((x) => isData(x.image) || /^media:/.test(x.video ?? ''))) {
      const next: Record<string, unknown>[] = [];
      for (const [i, x] of slides.entries()) { const r = ref(x.video); if (r !== x.video) rep.refs++; next.push({ ...x, image: await up(owner, 'store', x.image ?? '', `loja ${s.slug} banner ${i + 1}`), video: r }); }
      set.slides = next;
    }
    const reels = (s.reels ?? []) as { video?: string }[];
    if (reels.some((r) => /^media:/.test(r.video ?? ''))) set.reels = reels.map((r) => { const v = ref(r.video); if (v !== r.video) rep.refs++; return { ...r, video: v }; });
    rep.stores++;
    if (!opts.dry && Object.keys(set).length) await stores.updateOne({ _id: s._id, ...Object.fromEntries(Object.keys(set).map((k) => [k, k === 'seo.favicon' ? s.seo?.favicon : s[k]])) }, { $set: set });
  }

  // 4) Logo das empresas (comprovante).
  for await (const e of enterprises.find({ logo: DATA })) {
    const url = await up(String(e._id), 'logo', e.logo as string, `empresa ${e._id} logo`);
    rep.enterprises++;
    if (!opts.dry && url !== e.logo) await enterprises.updateOne({ _id: e._id, logo: e.logo }, { $set: { logo: url } });
  }

  // 5) Banners do marketplace (arquivos da plataforma).
  for await (const b of banners.find({ image: DATA })) {
    const url = await up(null, 'banner', b.image as string, `banner ${b._id}`);
    rep.banners++;
    if (!opts.dry && url !== b.image) await banners.updateOne({ _id: b._id, image: b.image }, { $set: { image: url } });
  }

  // 6) Opcional: apagar do GridFS os vídeos que já estão no R2 (o endereço antigo continua redirecionando).
  if (opts.deleteGridfs && !opts.dry) {
    for (const [id, url] of moved) if (!url.includes('(simulação)')) { await bucket.delete(new Types.ObjectId(id)).catch(() => {}); rep.gridfsDeleted++; }
  }
  log.log(`${opts.dry ? '[simulação] ' : ''}produtos ${rep.products}, lojas ${rep.stores}, empresas ${rep.enterprises}, banners ${rep.banners}, vídeos ${rep.videos}, referências de vídeo ${rep.refs}, apagados do GridFS ${rep.gridfsDeleted}, falhas ${rep.failures.length}`);
  return rep;
}
