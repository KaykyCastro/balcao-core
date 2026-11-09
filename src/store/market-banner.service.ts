import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MarketBannerDto, MarketBannerPatchDto } from './dto/market-banner.dto';
import { isLive, MAX_PER_PLACEMENT } from './market-banner.rules';
import { MarketBanner } from './schema/market-banner.schema';
import { StorageService } from '../storage/storage.service';

type Row = MarketBanner & { _id: Types.ObjectId; updatedAt?: Date };

/** Banners do marketplace: o admin cria e ordena; a vitrine pública só vê os que estão no ar. */
@Injectable()
export class MarketBannerService {
  constructor(@InjectModel(MarketBanner.name) private readonly banners: Model<MarketBanner>, private readonly storage: StorageService) {}

  private present(b: Row, admin = false) {
    const v = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    // Imagem no R2 (URL direta); só banners antigos ainda em base64 passam pela rota de imagem.
    const image = /^https?:\/\//.test(b.image) ? b.image : `/public/market/banners/${b._id}/image?v=${v}`;
    const base = { id: String(b._id), placement: b.placement, kind: b.kind, title: b.title, subtitle: b.subtitle, cta: b.cta, link: b.link, tone: b.tone, image };
    return admin ? { ...base, active: b.active, startsAt: b.startsAt, endsAt: b.endsAt, order: b.order, live: isLive(b), updatedAt: b.updatedAt } : base;
  }

  async adminList() {
    const rows = await this.banners.find().sort({ placement: 1, order: 1, createdAt: 1 }).lean();
    return rows.map((r) => this.present({ ...(r as unknown as Row), image: r.image.startsWith('data:') ? '' : r.image }, true));
  }

  async create(dto: MarketBannerDto) {
    if ((await this.banners.countDocuments({ placement: dto.placement })) >= MAX_PER_PLACEMENT) throw new BadRequestException(`No máximo ${MAX_PER_PLACEMENT} banners por carrossel`);
    this.checkDates(dto.startsAt, dto.endsAt);
    const order = dto.order ?? (await this.banners.countDocuments({ placement: dto.placement }));
    const image = await this.storage.resolve(null, 'banner', dto.image); // arquivo da plataforma no R2
    const b = await this.banners.create({ ...dto, image, order });
    return this.present(b.toObject() as Row, true);
  }

  async update(id: string, dto: MarketBannerPatchDto) {
    const cur = await this.banners.findById(id).lean();
    if (!cur) throw new NotFoundException('Banner não encontrado');
    this.checkDates(dto.startsAt === undefined ? cur.startsAt : dto.startsAt, dto.endsAt === undefined ? cur.endsAt : dto.endsAt);
    const set: Record<string, unknown> = { ...dto };
    if (dto.image !== undefined) set.image = await this.storage.resolve(null, 'banner', dto.image);
    const b = await this.banners.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    if (dto.image !== undefined && cur.image !== (b as Row).image) await this.storage.release(null, [cur.image]);
    return this.present(b as Row, true);
  }

  async remove(id: string) {
    const b = await this.banners.findByIdAndDelete(id).lean();
    if (!b) throw new NotFoundException('Banner não encontrado');
    await this.storage.release(null, [b.image]);
    return { ok: true };
  }

  /** Nova ordem de um carrossel: ids na ordem desejada. */
  async reorder(placement: 'hero' | 'middle', ids: string[]) {
    await Promise.all(ids.map((id, i) => this.banners.updateOne({ _id: id, placement }, { $set: { order: i } })));
    return { ok: true };
  }

  /** Os que estão no ar, por carrossel. */
  async live() {
    const rows = (await this.banners.find({ active: true }).sort({ order: 1, createdAt: 1 }).lean()) as unknown as Row[];
    const now = new Date();
    const out = rows.filter((r) => isLive(r, now)).map((r) => this.present({ ...r, image: r.image.startsWith('data:') ? '' : r.image }));
    return { hero: out.filter((b) => b.placement === 'hero'), middle: out.filter((b) => b.placement === 'middle') };
  }

  /** Imagem do banner (data URL guardada no banco). */
  async image(id: string): Promise<{ mime: string; data: Buffer } | { redirect: string }> {
    const b = await this.banners.findById(id).select('image').lean();
    if (!b) throw new NotFoundException('Banner não encontrado');
    if (/^https?:\/\//.test(b.image)) return { redirect: b.image };
    const m = b.image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!m) throw new NotFoundException('Imagem não encontrada');
    return { mime: m[1], data: Buffer.from(m[2], 'base64') };
  }

  private checkDates(a?: Date | null, b?: Date | null) {
    if (a && b && b <= a) throw new BadRequestException('O fim precisa ser depois do início');
  }
}
