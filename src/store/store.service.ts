import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Store, StoreDocument } from './schema/store.schema';
import { StoreUpdateDto } from './dto/store.dto';
import { MelhorEnvioClient } from './melhor-envio.client';
import { open, seal, sign, verifySigned } from './secret-box';
import { MercadoPagoClient } from './mercadopago.client';
import { baseShippingOptions, carrierOption, cleanCep, itemDims, slugify, slugProblem, type ShippingOption } from './store.rules';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { ProductService } from '../products/product.service';
import { CategoryService } from '../category/category.service';
import { isDuplicateKeyError } from '../common/mongo';
import { SettingsService } from '../settings/settings.service';
import { feeWaived, trialEnd } from '../billing/billing.rules';

export interface PricedLine { productId: string; name: string; quantity: number; unitCents: number; dims: { weightGrams?: number | null; heightCm?: number | null; widthCm?: number | null; lengthCm?: number | null } }

@Injectable()
export class StoreService {
  constructor(
    @InjectModel(Store.name) private readonly stores: Model<Store>,
    private readonly enterprises: EnterpriseService,
    private readonly products: ProductService,
    private readonly categories: CategoryService,
    private readonly me: MelhorEnvioClient,
    private readonly settings: SettingsService,
    private readonly mp: MercadoPagoClient,
  ) {}

  // ------------------------------------------------------------------ lojista

  /** Configuração da loja; cria um rascunho (desligado) na primeira visita. */
  async getOrCreate(enterpriseId: string): Promise<StoreDocument> {
    const found = await this.stores.findOne({ enterpriseId });
    if (found) return found;
    const ent = await this.enterprises.findEnterpriseById(enterpriseId);
    const base = slugify(ent.name) || 'minha-loja';
    for (let i = 0; i < 20; i++) {
      const slug = i === 0 && !slugProblem(base) ? base : `${base.slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}`;
      if (slugProblem(slug)) continue;
      try {
        return await this.stores.create({ enterpriseId, slug, name: ent.name.slice(0, 80) });
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        const again = await this.stores.findOne({ enterpriseId }); // corrida: outra aba criou
        if (again) return again;
      }
    }
    throw new ConflictException('Não foi possível reservar um endereço para a loja');
  }

  /** O que o painel vê. O token do Melhor Envio nunca sai: só `hasToken` e os 4 últimos caracteres. */
  async view(enterpriseId: string) {
    const s = await this.getOrCreate(enterpriseId);
    const withSecret = await this.stores.findById(s._id).select('+shipping.melhorEnvio.tokenSealed').lean();
    const json = s.toJSON() as Record<string, any>;
    const me = { ...(json.shipping?.melhorEnvio ?? {}) };
    delete me.tokenSealed;
    if (json.mp) { json.mp = { ...json.mp, connected: !!json.mp.userId }; delete json.mp.accessSealed; delete json.mp.refreshSealed; }
    me.hasToken = !!withSecret?.shipping?.melhorEnvio?.tokenSealed;
    return { ...json, shipping: { ...json.shipping, melhorEnvio: me }, checklist: this.checklist(s, me.hasToken), fees: await this.fees(enterpriseId) } as unknown as Record<string, any> & { enabled: boolean; checklist: { payment: boolean; shipping: boolean } };
  }

  /** Taxa da loja online que vale para esta empresa (mostrada no painel antes de ligar e em cada pedido). */
  async fees(enterpriseId: string) {
    const p = await this.settings.policy();
    const ent = await this.enterprises.findEnterpriseById(enterpriseId).catch(() => null);
    const waived = ent ? feeWaived(ent) : null;
    return { onlineRateBps: p.onlineRateBps, directoryRateBps: p.directoryRateBps, waived, waivedUntil: waived === 'trial' && ent ? trialEnd(ent) : null };
  }

  /** Pendências para ligar a loja. */
  private checklist(s: Store, hasToken: boolean) {
    const sh = s.shipping ?? {};
    const shippingOk = !!(sh.pickup?.enabled || (sh.local?.enabled && sh.local.cepRanges?.length) || sh.fixed?.enabled || (sh.melhorEnvio?.enabled && hasToken && sh.melhorEnvio.originCep));
    return { payment: !!s.mp?.userId, shipping: shippingOk };
  }

  async slugAvailable(enterpriseId: string, raw: string) {
    const slug = slugify(raw);
    const problem = slugProblem(slug);
    if (problem) return { slug, available: false, reason: problem };
    const taken = await this.stores.exists({ slug, enterpriseId: { $ne: new Types.ObjectId(enterpriseId) } });
    return { slug, available: !taken, reason: taken ? 'Esse endereço já está em uso' : null };
  }

  async update(enterpriseId: string, dto: StoreUpdateDto) {
    const current = await this.getOrCreate(enterpriseId);
    const set: Record<string, unknown> = {};
    if (dto.enabled === true && !current.feeAcceptedAt) {
      if (!dto.acceptOnlineFee) throw new UnprocessableEntityException({ statusCode: 422, code: 'FEE_ACCEPT_REQUIRED', message: 'Para ligar a loja, confirme que leu e concorda com a taxa da loja online.' });
      const p = await this.settings.policy();
      set.feeAcceptedAt = new Date();
      set.feeAcceptedRates = { onlineRateBps: p.onlineRateBps, directoryRateBps: p.directoryRateBps };
    }
    const plain = ['enabled', 'ordersPaused', 'name', 'tagline', 'about', 'segment', 'city', 'listed', 'logo', 'banner', 'notice', 'minOrderCents'] as const;
    for (const k of plain) if (dto[k] !== undefined) set[k] = typeof dto[k] === 'string' ? (dto[k] as string).trim() : dto[k];
    if (dto.name !== undefined && !dto.name.trim()) throw new BadRequestException('Dê um nome para a loja');
    if (dto.state !== undefined) set.state = dto.state.toUpperCase();
    if (dto.slug !== undefined) {
      const slug = slugify(dto.slug);
      const problem = slugProblem(slug);
      if (problem) throw new UnprocessableEntityException(problem);
      set.slug = slug;
    }
    for (const group of ['theme', 'contacts', 'policies'] as const) {
      const g = dto[group] as Record<string, unknown> | undefined;
      if (g) for (const [k, v] of Object.entries(g)) if (v !== undefined) set[`${group}.${k}`] = typeof v === 'string' ? v.trim() : v;
    }
    if (dto.contacts?.whatsapp !== undefined) set['contacts.whatsapp'] = dto.contacts.whatsapp.replace(/\D/g, '');
    if (dto.contacts?.instagram !== undefined) set['contacts.instagram'] = dto.contacts.instagram.replace(/^@/, '');
    const sh = dto.shipping as Record<string, Record<string, unknown>> | undefined;
    if (sh) {
      for (const [m, fields] of Object.entries(sh)) {
        if (!fields) continue;
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue;
          if (m === 'melhorEnvio' && k === 'token') {
            const tok = String(v).trim();
            set['shipping.melhorEnvio.tokenSealed'] = tok ? seal(tok) : null;
            set['shipping.melhorEnvio.tokenHint'] = tok ? `…${tok.slice(-4)}` : '';
            continue;
          }
          if (k === 'originCep' && typeof v === 'string') { set[`shipping.${m}.${k}`] = v.replace(/\D/g, ''); continue; }
          if (k === 'cepRanges' && Array.isArray(v)) { set[`shipping.${m}.${k}`] = v.map((r: { from: string; to: string }) => ({ from: r.from.replace(/\D/g, ''), to: r.to.replace(/\D/g, '') })); continue; }
          set[`shipping.${m}.${k}`] = typeof v === 'string' ? v.trim() : v;
        }
      }
    }
    if (dto.shipping?.fixed?.minDays !== undefined || dto.shipping?.fixed?.maxDays !== undefined) {
      const min = dto.shipping.fixed.minDays ?? current.shipping?.fixed?.minDays ?? 3;
      const max = dto.shipping.fixed.maxDays ?? current.shipping?.fixed?.maxDays ?? min;
      if (max < min) throw new UnprocessableEntityException('Prazo máximo menor que o mínimo');
    }

    try {
      await this.stores.updateOne({ _id: current._id }, { $set: set }, { runValidators: true });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Esse endereço de loja já está em uso');
      throw e;
    }
    // Só fica no ar com pagamento e entrega configurados.
    const after = await this.view(enterpriseId);
    if (after.enabled && (!after.checklist.payment || !after.checklist.shipping)) {
      await this.stores.updateOne({ _id: current._id }, { $set: { enabled: false } });
      throw new UnprocessableEntityException(!after.checklist.payment ? 'Para ligar a loja, conecte sua conta do Mercado Pago em Pagamento.' : 'Para ligar a loja, ative ao menos uma forma de entrega.');
    }
    return after;
  }

  // ------------------------------------------------------------------ Mercado Pago (OAuth do lojista)

  /** Link para conectar a conta. O `state` assinado amarra a volta a esta empresa e expira em 15 min. */
  async mpConnectUrl(enterpriseId: string) {
    const exp = Date.now() + 15 * 60_000;
    const state = `${enterpriseId}.${exp}.${sign('mp-oauth', `${enterpriseId}.${exp}`)}`;
    return { url: this.mp.authUrl(state) };
  }

  async mpCallback(enterpriseId: string, code: string, state: string) {
    const [eid, exp, sig] = String(state).split('.');
    if (eid !== enterpriseId || !verifySigned('mp-oauth', `${eid}.${exp}`, sig) || Number(exp) < Date.now()) throw new UnprocessableEntityException('Conexão expirada ou inválida. Clique em “Conectar Mercado Pago” de novo.');
    const store = await this.getOrCreate(enterpriseId);
    const t = await this.mp.exchangeCode(code);
    const me = await this.mp.me(t.accessToken).catch(() => ({ id: t.userId, nickname: '', email: '' }));
    await this.stores.updateOne({ _id: store._id }, { $set: { mp: {
      userId: t.userId || me.id, nickname: me.nickname, email: me.email, publicKey: t.publicKey,
      accessSealed: seal(t.accessToken), refreshSealed: seal(t.refreshToken), expiresAt: t.expiresAt, connectedAt: new Date(),
    } } });
    return this.view(enterpriseId);
  }

  /** Desconecta. Com a loja no ar, ela é desligada (sem conta não há como receber). */
  async mpDisconnect(enterpriseId: string) {
    const store = await this.getOrCreate(enterpriseId);
    await this.stores.updateOne({ _id: store._id }, { $set: { enabled: false, mp: { userId: '', nickname: '', email: '', publicKey: '', accessSealed: null, refreshSealed: null, expiresAt: null, connectedAt: null } } });
    return this.view(enterpriseId);
  }

  /** Token de acesso do lojista, renovado sozinho quando falta menos de 7 dias para vencer. */
  async mpAccessToken(storeId: Types.ObjectId | string): Promise<string> {
    const s = await this.stores.findById(storeId).select('+mp.accessSealed +mp.refreshSealed').lean();
    const access = open(s?.mp?.accessSealed), refresh = open(s?.mp?.refreshSealed);
    if (!s || !access || !refresh) throw new ConflictException('A loja não está conectada ao Mercado Pago');
    if (s.mp.expiresAt && new Date(s.mp.expiresAt).getTime() - Date.now() > 7 * 86_400_000) return access;
    const t = await this.mp.refresh(refresh);
    await this.stores.updateOne({ _id: s._id }, { $set: { 'mp.accessSealed': seal(t.accessToken), 'mp.refreshSealed': seal(t.refreshToken), 'mp.expiresAt': t.expiresAt } });
    return t.accessToken;
  }

  // ------------------------------------------------------------------ vitrine pública

  /** Loja no ar pelo endereço. Empresa suspensa ou bloqueada por fatura não vende online. */
  async publicBySlug(slug: string, opts: { forOrder?: boolean } = {}) {
    const s = await this.stores.findOne({ slug: String(slug).toLowerCase().slice(0, 40), enabled: true });
    if (!s) throw new NotFoundException('Loja não encontrada');
    const ent = await this.enterprises.findEnterpriseById(String(s.enterpriseId)).catch(() => null);
    if (!ent || ent.status === 'suspended') throw new NotFoundException('Loja não encontrada');
    const closed = ent.billing?.status === 'blocked' || s.ordersPaused;
    if (opts.forOrder && closed) throw new ConflictException('Esta loja não está recebendo pedidos no momento');
    return { store: s, enterprise: ent, closed };
  }

  /** Dados da vitrine (sem nada interno). */
  async publicInfo(slug: string) {
    const { store: s, enterprise, closed } = await this.publicBySlug(slug);
    const cats = await this.categories.list(String(s.enterpriseId));
    const sh = s.shipping ?? {};
    return {
      slug: s.slug, name: s.name, tagline: s.tagline, about: s.about, segment: s.segment, city: s.city, state: s.state,
      logo: s.logo || enterprise.logo || '', banner: s.banner, notice: s.notice, theme: s.theme, contacts: s.contacts, policies: s.policies,
      minOrderCents: s.minOrderCents, closed,
      categories: cats.map((c) => ({ id: String(c._id), name: (c as unknown as { name: string }).name })),
      shipping: {
        pickup: sh.pickup?.enabled ? { address: sh.pickup.address, instructions: sh.pickup.instructions } : null,
        local: !!sh.local?.enabled, fixed: !!sh.fixed?.enabled, carriers: !!sh.melhorEnvio?.enabled,
        freeAboveCents: minOrNull([sh.local, sh.fixed, sh.melhorEnvio].filter((m) => m?.enabled && m.freeAboveCents).map((m) => m.freeAboveCents as number)),
      },
    };
  }

  /** Opções de entrega para o CEP. Preço sempre calculado aqui (o checkout recalcula, nunca confia no navegador). */
  async quote(store: StoreDocument, cepRaw: string | null, lines: PricedLine[]): Promise<ShippingOption[]> {
    const cep = cepRaw ? cleanCep(cepRaw) : null;
    if (cepRaw && !cep) throw new UnprocessableEntityException('CEP inválido');
    const sh = store.shipping ?? {};
    const subtotal = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
    const out = baseShippingOptions(sh, cep, subtotal);
    if (cep && sh.melhorEnvio?.enabled && sh.melhorEnvio.originCep) {
      const sealed = (await this.stores.findById(store._id).select('+shipping.melhorEnvio.tokenSealed').lean())?.shipping?.melhorEnvio?.tokenSealed;
      const token = open(sealed);
      if (token) {
        try {
          const quotes = await this.me.quote({
            token, sandbox: !!sh.melhorEnvio.sandbox, fromCep: sh.melhorEnvio.originCep, toCep: cep,
            products: lines.map((l) => ({ id: l.productId, quantity: l.quantity, insuranceCents: l.unitCents, ...itemDims(l.dims, sh.package) })),
          });
          for (const q of quotes.slice(0, 6)) out.push(carrierOption(q, sh.melhorEnvio, subtotal));
        } catch {
          // Transportadora fora do ar: as outras opções continuam valendo.
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ diretório "Lojas no Balcão"

  async directory(q: { search?: string; segment?: string; state?: string; page: number; limit: number }) {
    const filter: Record<string, unknown> = { enabled: true, listed: true };
    if (q.segment) filter.segment = q.segment;
    if (q.state) filter.state = q.state.toUpperCase();
    if (q.search?.trim()) {
      const rx = { $regex: q.search.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ name: rx }, { tagline: rx }, { city: rx }];
    }
    const [rows, total] = await Promise.all([
      this.stores.find(filter).sort({ updatedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).select('enterpriseId slug name tagline segment city state logo banner theme.accent').lean(),
      this.stores.countDocuments(filter),
    ]);
    const counts = await this.products.countOnline(rows.map((r) => String(r.enterpriseId)));
    const items: Record<string, unknown>[] = [];
    for (const r of rows) {
      let logo = r.logo;
      if (!logo) logo = (await this.enterprises.findEnterpriseById(String(r.enterpriseId)).catch(() => null))?.logo ?? '';
      items.push({ slug: r.slug, name: r.name, tagline: r.tagline, segment: r.segment, city: r.city, state: r.state, logo, banner: r.banner, accent: r.theme?.accent ?? '#FF3D00', products: counts.get(String(r.enterpriseId)) ?? 0 });
    }
    return { items, total, page: q.page, limit: q.limit };
  }

  /** Lojas listadas no ar (para a busca de produtos entre lojas). */
  async listedStores(): Promise<{ enterpriseId: string; slug: string; name: string; accent: string }[]> {
    const rows = await this.stores.find({ enabled: true, listed: true, ordersPaused: false }).select('enterpriseId slug name theme.accent').limit(500).lean();
    return rows.map((r) => ({ enterpriseId: String(r.enterpriseId), slug: r.slug, name: r.name, accent: r.theme?.accent ?? '#FF3D00' }));
  }

  /** Próximo número de pedido da loja (#1001...). */
  async nextOrderNumber(storeId: Types.ObjectId, session?: import('mongoose').ClientSession): Promise<number> {
    const s = await this.stores.findOneAndUpdate({ _id: storeId }, { $inc: { orderSeq: 1 } }, { returnDocument: 'after', session });
    return s!.orderSeq;
  }
}

const minOrNull = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
