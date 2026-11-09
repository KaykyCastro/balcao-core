import { StorageService } from '../storage/storage.service';
import { removedUrls } from '../storage/storage.rules';
import { CodeService } from './code/code.service';
import { pageMedia, pageUrls, sanitizePage, type SitePage } from './builder.rules';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Store, StoreDocument } from './schema/store.schema';
import { StoreUpdateDto } from './dto/store.dto';
import { MelhorEnvioClient } from './melhor-envio.client';
import { open, seal, sign, verifySigned } from '../common/secret-box';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { baseShippingOptions, carrierOption, cleanCep, itemDims, slugify, slugProblem, type ShippingOption } from './store.rules';
import { hasCheckout, MODE_RULES, modeOf, SELECTABLE_MODES, WHATSAPP_RE } from './store.rules';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { ProductService } from '../products/product.service';
import { CategoryService } from '../category/category.service';
import { isDuplicateKeyError } from '../common/mongo';
import { formatDoc, onlyDigits, validDoc } from '../common/br-doc';
import { SettingsService } from '../settings/settings.service';
import { feeWaived, trialEnd } from '../billing/billing.rules';
import { crossTenant } from '../common/security/tenant-guard.plugin';

export interface PricedLine { productId: string; name: string; quantity: number; unitCents: number; dims: { weightGrams?: number | null; heightCm?: number | null; widthCm?: number | null; lengthCm?: number | null } }

/** Imagens que a loja usa (para saber o que apagar do R2 quando saem). */
function storeImages(s: { logo?: string; banner?: string; slides?: { image?: string }[]; seo?: { favicon?: string }; page?: SitePage | null; pageDraft?: SitePage | null }) {
  return [s.logo, s.banner, s.seo?.favicon, ...(s.slides ?? []).map((x) => x.image), ...pageUrls(s.page), ...pageUrls(s.pageDraft)].filter((x): x is string => !!x);
}

/** Campos que só mudam a aparência da loja: salvar só eles não refaz a checagem de "pode ficar no ar". */
const LOOK_ONLY = ['theme', 'tagline', 'about', 'logo', 'banner', 'notice', 'slides', 'reels', 'reelsTitle', 'highlights', 'seo'] as const;

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
    private readonly storage: StorageService,
    private readonly code: CodeService = new CodeService(),
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
    const withSecret = await this.stores.findOne({ _id: s._id, enterpriseId: s.enterpriseId }).select('+shipping.melhorEnvio.tokenSealed').lean();
    const json = s.toJSON() as Record<string, any>;
    const me = { ...(json.shipping?.melhorEnvio ?? {}) };
    delete me.tokenSealed;
    if (json.mp) { json.mp = { ...json.mp, connected: !!json.mp.userId }; delete json.mp.accessSealed; delete json.mp.refreshSealed; }
    me.hasToken = !!withSecret?.shipping?.melhorEnvio?.tokenSealed;
    return { ...json, mode: modeOf(s), shipping: { ...json.shipping, melhorEnvio: me }, checklist: this.checklist(s, me.hasToken), fees: await this.fees(enterpriseId) } as unknown as Record<string, any> & { enabled: boolean; checklist: { payment: boolean; shipping: boolean; legal: boolean; whatsapp: boolean } };
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
    const ok = MODE_RULES[modeOf(s)].shipping;
    const shippingOk = !!((ok.includes('table') && s.tables?.enabled) || (ok.includes('pickup') && sh.pickup?.enabled) || (ok.includes('local') && sh.local?.enabled && sh.local.cepRanges?.length) || (ok.includes('fixed') && sh.fixed?.enabled) || (ok.includes('carrier') && sh.melhorEnvio?.enabled && hasToken && sh.melhorEnvio.originCep));
    const l = s.legal ?? ({} as Store['legal']);
    const legal = !!(l.name && validDoc(l.document ?? '') && l.address && l.email);
    // Catálogo online: sem pagamento nem entrega no site; só precisa do WhatsApp para receber os contatos.
    if (!hasCheckout(modeOf(s))) return { payment: true, shipping: true, legal, whatsapp: WHATSAPP_RE.test(s.contacts?.whatsapp ?? '') };
    return { payment: !!s.mp?.userId, shipping: shippingOk, legal, whatsapp: true };
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
    if (dto.enabled === true && current.adminBlock?.at) {
      throw new ForbiddenException({ statusCode: 403, code: 'STORE_BLOCKED', message: `Sua loja foi suspensa pela plataforma${current.adminBlock.reason ? `: ${current.adminBlock.reason}` : ''}. Fale com o suporte para reativar.` });
    }
    const nextMode = dto.mode ?? modeOf(current);
    if (dto.mode !== undefined && dto.mode !== modeOf(current) && !SELECTABLE_MODES.includes(dto.mode)) {
      throw new UnprocessableEntityException({ statusCode: 422, code: 'MODE_UNAVAILABLE', message: dto.mode === 'menu' ? 'O modo Cardápio está em desenvolvimento.' : 'Esse modo não está mais disponível. Escolha E-commerce ou Catálogo online.' });
    }
    // A taxa da loja online incide sobre pedidos pagos no site: o Catálogo online (WhatsApp) não tem pedidos.
    const willBeOn = dto.enabled ?? current.enabled;
    const turningOn = dto.enabled === true || (dto.mode !== undefined && dto.mode !== modeOf(current) && current.enabled);
    if (turningOn && willBeOn && hasCheckout(nextMode) && !current.feeAcceptedAt) {
      if (!dto.acceptOnlineFee) throw new UnprocessableEntityException({ statusCode: 422, code: 'FEE_ACCEPT_REQUIRED', message: 'Para ligar a loja, confirme que leu e concorda com a taxa da loja online.' });
      const p = await this.settings.policy();
      set.feeAcceptedAt = new Date();
      set.feeAcceptedRates = { onlineRateBps: p.onlineRateBps, directoryRateBps: p.directoryRateBps };
    }
    const plain = ['enabled', 'ordersPaused', 'name', 'tagline', 'about', 'segment', 'city', 'listed', 'logo', 'banner', 'notice', 'hours', 'minOrderCents'] as const;
    if (dto.slides !== undefined) {
      if (dto.slides.some((x) => !x.image && !x.video)) throw new UnprocessableEntityException('Cada banner precisa de uma imagem ou de um vídeo');
    }
    if (dto.reels !== undefined) set.reels = dto.reels.map((r) => ({ video: r.video, productId: r.productId, title: r.title?.trim() ?? '' })).filter((r) => r.video);
    if (dto.reelsTitle !== undefined) set.reelsTitle = dto.reelsTitle.trim();
    if (dto.highlights !== undefined) set.highlights = dto.highlights.filter((h) => h.title.trim()).map((h) => ({ icon: h.icon, title: h.title.trim(), text: h.text?.trim() ?? '' }));
    const mode = dto.mode ?? modeOf(current);
    if (dto.mode !== undefined) set.mode = dto.mode;
    // Mesas só existem no modo cardápio.
    if (dto.tables?.enabled && !MODE_RULES[mode].tables) throw new UnprocessableEntityException('Mesas e comandas são do modo Cardápio. Mude o modo da loja primeiro.');
    if (dto.mode !== undefined && !MODE_RULES[mode].tables && current.tables?.enabled) set['tables.enabled'] = false;
    if (dto.payOnDelivery) {
      if (dto.payOnDelivery.enabled !== undefined) set['payOnDelivery.enabled'] = dto.payOnDelivery.enabled;
      if (dto.payOnDelivery.methods !== undefined) {
        if (!dto.payOnDelivery.methods.length) throw new UnprocessableEntityException('Escolha ao menos uma forma de pagamento na entrega');
        set['payOnDelivery.methods'] = [...new Set(dto.payOnDelivery.methods)];
      }
    }
    if (dto.tables) {
      if (dto.tables.payment !== undefined) set['tables.payment'] = dto.tables.payment;
      if (dto.tables.serviceRateBps !== undefined) set['tables.serviceRateBps'] = dto.tables.serviceRateBps;
      if (dto.tables.enabled !== undefined) set['tables.enabled'] = dto.tables.enabled;
      if (dto.tables.count !== undefined) set['tables.count'] = dto.tables.count;
      if (dto.tables.label !== undefined) set['tables.label'] = dto.tables.label.trim() || 'Mesa';
    }
    if (dto.slides !== undefined) set.slides = dto.slides.map((x) => ({ image: x.image ?? '', video: x.video ?? '', title: x.title?.trim() ?? '', subtitle: x.subtitle?.trim() ?? '', cta: x.cta?.trim() ?? '', link: x.link ?? '', align: x.align ?? 'left', tone: x.tone ?? 'light' }));
    for (const k of plain) if (dto[k] !== undefined) set[k] = typeof dto[k] === 'string' ? (dto[k] as string).trim() : dto[k];
    if (dto.name !== undefined && !dto.name.trim()) throw new BadRequestException('Dê um nome para a loja');
    if (dto.state !== undefined) set.state = dto.state.toUpperCase();
    if (dto.slug !== undefined) {
      const slug = slugify(dto.slug);
      const problem = slugProblem(slug);
      if (problem) throw new UnprocessableEntityException(problem);
      set.slug = slug;
    }
    for (const group of ['theme', 'contacts', 'policies', 'legal', 'seo', 'cashback'] as const) {
      const g = dto[group] as Record<string, unknown> | undefined;
      if (g) for (const [k, v] of Object.entries(g)) if (v !== undefined) set[`${group}.${k}`] = typeof v === 'string' ? v.trim() : v;
    }
    if (dto.legal?.document !== undefined) set['legal.document'] = onlyDigits(dto.legal.document);
    if (dto.legal?.phone !== undefined) set['legal.phone'] = onlyDigits(dto.legal.phone);
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
          if (k === 'sender' && v && typeof v === 'object') {
            for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
              if (typeof sv !== 'string') continue;
              set[`shipping.melhorEnvio.sender.${sk}`] = sk === 'document' || sk === 'phone' ? sv.replace(/\D/g, '') : sk === 'state' ? sv.trim().toUpperCase() : sv.trim();
            }
            continue;
          }
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

    // Arquivos: só URLs do R2 desta empresa (ou https externo). Base64 de cliente antigo sobe para o R2 aqui.
    const filesBefore = storeImages(current);
    if (set.logo !== undefined) set.logo = await this.storage.resolve(enterpriseId, 'store', set.logo as string);
    if (set.banner !== undefined) set.banner = await this.storage.resolve(enterpriseId, 'store', set.banner as string);
    if (set['seo.favicon'] !== undefined) set['seo.favicon'] = await this.storage.resolve(enterpriseId, 'favicon', set['seo.favicon'] as string);
    if (set.slides) {
      for (const x of set.slides as { image: string; video: string }[]) {
        x.image = await this.storage.resolve(enterpriseId, 'store', x.image);
        x.video = await this.storage.resolve(enterpriseId, 'video', x.video);
      }
    }
    if (set.reels) for (const r of set.reels as { video: string }[]) r.video = await this.storage.resolve(enterpriseId, 'video', r.video);

    try {
      await this.stores.updateOne({ _id: current._id }, { $set: set }, { runValidators: true });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Esse endereço de loja já está em uso');
      throw e;
    }
    // Imagens que saíram da loja (trocou o logo, tirou um banner...): apaga do R2. Vídeos ficam na biblioteca.
    const gone = removedUrls(filesBefore, storeImages({
      logo: (set.logo as string | undefined) ?? current.logo, banner: (set.banner as string | undefined) ?? current.banner,
      slides: (set.slides as { image?: string }[] | undefined) ?? current.slides, seo: { favicon: (set['seo.favicon'] as string | undefined) ?? current.seo?.favicon }, page: current.page, pageDraft: current.pageDraft,
    }));
    if (gone.length) await this.storage.release(enterpriseId, gone);
    // Só fica no ar com pagamento e entrega configurados. Mudança só de aparência (aba Tema do construtor, logo, banners,
    // textos) não mexe nisso: salvar uma cor não pode desligar a loja.
    const after = await this.view(enterpriseId);
    // (Os DTOs declaram todos os campos; contam só os que vieram com valor.)
    if (Object.entries(dto).every(([k, v]) => v === undefined || (LOOK_ONLY as readonly string[]).includes(k))) return after;
    // Ligar a loja exige os dados do vendedor (lei do comércio eletrônico). Lojas já no ar só recebem o aviso no painel.
    if (dto.enabled === true && !current.enabled && !after.checklist.legal) {
      await this.stores.updateOne({ _id: current._id }, { $set: { enabled: false } });
      throw new UnprocessableEntityException({ statusCode: 422, code: 'LEGAL_REQUIRED', message: 'Para ligar a loja, preencha os dados do vendedor (nome ou razão social, CPF/CNPJ, endereço e e-mail) em Site da loja, Aparência e conteúdo.' });
    }
    if (after.enabled && !after.checklist.whatsapp) {
      await this.stores.updateOne({ _id: current._id }, { $set: { enabled: false } });
      throw new UnprocessableEntityException({ statusCode: 422, code: 'WHATSAPP_REQUIRED', message: 'Para ligar o Catálogo online, informe o WhatsApp da loja em Contatos.' });
    }
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
  /** Link de prévia para o lojista ver a loja antes de ligar (vale 3 horas; não aceita pedidos). */
  async previewLink(enterpriseId: string) {
    const s = await this.getOrCreate(enterpriseId);
    const exp = Date.now() + 3 * 3600_000;
    const token = `${s._id}.${exp}.${sign('store-preview', `${s._id}.${exp}`)}`;
    return { slug: s.slug, token, expiresAt: new Date(exp) };
  }
  private previewOk(storeId: unknown, token?: string): boolean {
    if (!token) return false;
    const [id, exp, sig] = String(token).split('.');
    return id === String(storeId) && Number(exp) > Date.now() && verifySigned('store-preview', `${id}.${exp}`, sig);
  }

  async publicBySlug(slug: string, opts: { forOrder?: boolean; preview?: string } = {}) {
    const s = await crossTenant(this.stores, 'vitrine: lojas publicadas (só dados públicos)').findOne({ slug: String(slug).toLowerCase().slice(0, 40) });
    // Loja desligada só aparece para o dono, com o link de prévia (e sem aceitar pedidos).
    const preview = !!s && !s.enabled && !s.adminBlock?.at && this.previewOk(s._id, opts.preview);
    if (!s || (!s.enabled && !preview)) throw new NotFoundException('Loja não encontrada');
    const ent = await this.enterprises.findEnterpriseById(String(s.enterpriseId)).catch(() => null);
    if (!ent || ent.status === 'suspended') throw new NotFoundException('Loja não encontrada');
    const closed = ent.billing?.status === 'blocked' || s.ordersPaused || preview;
    if (opts.forOrder && !hasCheckout(modeOf(s))) throw new ConflictException({ statusCode: 409, code: 'CATALOG_ONLY', message: 'Esta loja atende pelo WhatsApp. Use o botão do produto para falar com a loja.' });
    if (opts.forOrder && closed) throw new ConflictException(preview ? 'Prévia: a loja ainda não está recebendo pedidos' : 'Esta loja não está recebendo pedidos no momento');
    return { store: s, enterprise: ent, closed, preview };
  }

  /**
   * Construtor de sites: salva o rascunho (`publish` falso) ou põe a página no ar. Imagens e vídeos passam pelo
   * StorageService (só arquivos desta empresa ou https externo); imagens que saíram da loja são apagadas do R2.
   */
  async savePage(enterpriseId: string, raw: unknown, publish = false) {
    const current = await this.stores.findOne({ enterpriseId });
    if (!current) throw new NotFoundException('Crie a loja antes de montar o site');
    const page = sanitizePage(raw);
    await this.code.compilePage(page); // componente Código: árvore e CSS gerados aqui, nunca vindos do navegador
    for (const m of pageMedia(page)) m.set(await this.storage.resolve(enterpriseId, m.kind === 'video' ? 'video' : 'store', m.get()));
    const before = storeImages(current);
    const at = new Date();
    const set: Record<string, unknown> = { pageDraft: page, ...(publish ? { page, pagePublishedAt: at } : {}) };
    await this.stores.updateOne({ _id: current._id }, { $set: set });
    const gone = removedUrls(before, storeImages({ logo: current.logo, banner: current.banner, slides: current.slides, seo: current.seo, page: publish ? page : current.page, pageDraft: page }));
    // Vídeos ficam na biblioteca (podem estar nos "vídeos que vendem"); só imagens saem do R2.
    const images = gone.filter((u) => !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u));
    if (images.length) await this.storage.release(enterpriseId, images);
    return { pageDraft: page, page: publish ? page : current.page, pagePublishedAt: publish ? at : current.pagePublishedAt };
  }

  /** Dados da vitrine (sem nada interno). */
  async publicInfo(slug: string, previewToken?: string) {
    const { store: s, enterprise, closed, preview } = await this.publicBySlug(slug, { preview: previewToken });
    const [cats, covers] = await Promise.all([this.categories.list(String(s.enterpriseId)), this.products.coverByCategory(String(s.enterpriseId))]);
    const mode = modeOf(s);
    const allow = new Set(MODE_RULES[mode].shipping);
    const tablesOn = !!s.tables?.enabled && allow.has('table');
    const all = s.shipping ?? {};
    // Só o que o modo da loja permite (ex.: loja virtual não envia por transportadora).
    const sh = { pickup: allow.has('pickup') ? all.pickup : undefined, local: allow.has('local') ? all.local : undefined, fixed: allow.has('fixed') ? all.fixed : undefined, melhorEnvio: allow.has('carrier') ? all.melhorEnvio : undefined };
    const l = s.legal ?? ({} as typeof s.legal);
    return {
      slug: s.slug, name: s.name, tagline: s.tagline, about: s.about, segment: s.segment, city: s.city, state: s.state,
      logo: s.logo || enterprise.logo || '', banner: s.banner, notice: s.notice, hours: s.hours ?? '', // Lado a lado (split) usa o primeiro banner.
      slides: s.slides ?? [], theme: s.theme,
      highlights: s.highlights ?? [], reelsTitle: s.reelsTitle ?? '', reels: (s.reels ?? []).map((r) => ({ video: r.video, productId: r.productId, title: r.title ?? '' })),
      // Pagar na entrega/retirada: só fora do e-commerce (entrega própria ou retirada).
      payOnDelivery: mode !== 'ecommerce' && s.payOnDelivery?.enabled && s.payOnDelivery.methods?.length ? { methods: s.payOnDelivery.methods } : null,
      mode, tables: tablesOn ? { count: s.tables.count || 10, label: s.tables.label || 'Mesa', payment: s.tables.payment ?? 'tab', serviceRateBps: s.tables.serviceRateBps ?? 0 } : null, contacts: s.contacts, policies: s.policies,
      minOrderCents: s.minOrderCents, closed, preview,
      // Cashback: só o que a vitrine precisa mostrar ("5% de volta em crédito").
      cashback: s.cashback?.enabled && s.cashback.rateBps ? { rateBps: s.cashback.rateBps, expiresDays: s.cashback.expiresDays || 90 } : null,
      page: s.page ?? null,
      seo: { title: s.seo?.title ?? '', description: s.seo?.description ?? '', favicon: s.seo?.favicon ? `/public/store/${s.slug}/icon` : '' },
      categories: cats.map((c) => ({ id: String(c._id), name: (c as unknown as { name: string }).name, cover: covers.get(String(c._id)) ?? null })),
      // Identificação do vendedor (Decreto 7.962/2013). Só o que a lei pede mostrar.
      legal: { name: l?.name ?? '', document: l?.document ? formatDoc(l.document) : '', address: l?.address ?? '', email: l?.email ?? '', phone: l?.phone ?? '' },
      shipping: {
        pickup: sh.pickup?.enabled ? { address: sh.pickup.address, instructions: sh.pickup.instructions } : null,
        local: !!sh.local?.enabled, localEta: sh.local?.enabled ? sh.local.etaText ?? '' : '', localPriceCents: sh.local?.enabled ? sh.local.priceCents ?? 0 : null, fixed: !!sh.fixed?.enabled, carriers: !!sh.melhorEnvio?.enabled,
        freeAboveCents: minOrNull([sh.local, sh.fixed, sh.melhorEnvio].filter((m) => m?.enabled && m.freeAboveCents).map((m) => m.freeAboveCents as number)),
      },
    };
  }

  /** Opções de entrega para o CEP. Preço sempre calculado aqui (o checkout recalcula, nunca confia no navegador). */
  async quote(store: StoreDocument, cepRaw: string | null, lines: PricedLine[]): Promise<ShippingOption[]> {
    const cep = cepRaw ? cleanCep(cepRaw) : null;
    if (cepRaw && !cep) throw new UnprocessableEntityException('CEP inválido');
    const allow = new Set(MODE_RULES[modeOf(store)].shipping);
    const all = store.shipping ?? {};
    const sh = { ...all, pickup: allow.has('pickup') ? all.pickup : undefined, local: allow.has('local') ? all.local : undefined, fixed: allow.has('fixed') ? all.fixed : undefined, melhorEnvio: allow.has('carrier') ? all.melhorEnvio : undefined } as typeof all;
    const subtotal = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
    const out = baseShippingOptions(sh, cep, subtotal);
    // Pedido na mesa pago na hora (sem comanda): sem frete e sem endereço; a mesa vem no checkout.
    if (allow.has('table') && store.tables?.enabled && store.tables.payment === 'upfront') out.unshift({ id: 'table', kind: 'table', name: `Na ${(store.tables.label || 'Mesa').toLowerCase()}`, priceCents: 0, etaText: 'Levamos até você', free: true });
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
      crossTenant(this.stores, 'vitrine: lojas publicadas (só dados públicos)').find(filter).sort({ updatedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).select('enterpriseId slug name tagline segment city state logo banner theme.accent cashback').lean(),
      crossTenant(this.stores, 'vitrine: lojas publicadas (só dados públicos)').countDocuments(filter),
    ]);
    const counts = await this.products.countOnline(rows.map((r) => String(r.enterpriseId)));
    const items: Record<string, unknown>[] = [];
    for (const r of rows) {
      let logo = r.logo;
      if (!logo) logo = (await this.enterprises.findEnterpriseById(String(r.enterpriseId)).catch(() => null))?.logo ?? '';
      items.push({ slug: r.slug, name: r.name, tagline: r.tagline, segment: r.segment, city: r.city, state: r.state, logo, banner: r.banner, accent: r.theme?.accent ?? '#FF3D00', cashbackBps: r.cashback?.enabled ? r.cashback.rateBps ?? 0 : 0, products: counts.get(String(r.enterpriseId)) ?? 0 });
    }
    return { items, total, page: q.page, limit: q.limit };
  }

  /** Vídeos das lojas listadas ("vídeos que vendem"), para a faixa de vídeos do marketplace. */
  async listedReels() {
    const rows = await crossTenant(this.stores, 'vitrine: lojas publicadas (só dados públicos)').find({ enabled: true, listed: true, ordersPaused: false, 'reels.0': { $exists: true } }).select('enterpriseId slug name logo theme.accent cashback reels').limit(60).lean();
    return rows.map((r) => ({ enterpriseId: String(r.enterpriseId), slug: r.slug, name: r.name, logo: r.logo ?? '', accent: r.theme?.accent ?? '#FF3D00', cashbackBps: r.cashback?.enabled ? r.cashback.rateBps ?? 0 : 0, reels: (r.reels ?? []).filter((x) => x.video && x.productId).slice(0, 6) }));
  }

  /** Lojas listadas no ar (para a busca de produtos entre lojas). */
  /** Lojas no ar para o sitemap (o painel do Balcão decide o que listar; desligadas e suspensas ficam de fora). */
  async sitemapStores(): Promise<{ slug: string; enterpriseId: string; updatedAt: Date | null }[]> {
    const rows = await this.stores.find({ enabled: true, 'adminBlock.at': null }).select('slug enterpriseId updatedAt').limit(5000).lean();
    return rows.map((r) => ({ slug: r.slug, enterpriseId: String(r.enterpriseId), updatedAt: (r as unknown as { updatedAt?: Date }).updatedAt ?? null }));
  }

  async listedStores(): Promise<{ enterpriseId: string; slug: string; name: string; accent: string; segment: string; logo: string; cashbackBps: number }[]> {
    const rows = await crossTenant(this.stores, 'vitrine: lojas publicadas (só dados públicos)').find({ enabled: true, listed: true, ordersPaused: false }).select('enterpriseId slug name segment logo theme.accent cashback').limit(500).lean();
    return rows.map((r) => ({ enterpriseId: String(r.enterpriseId), slug: r.slug, name: r.name, accent: r.theme?.accent ?? '#FF3D00', segment: r.segment ?? '', logo: r.logo ?? '', cashbackBps: r.cashback?.enabled ? r.cashback.rateBps ?? 0 : 0 }));
  }

  /** Próximo número de comanda da loja (#1, #2...). */
  async nextTabNumber(storeId: Types.ObjectId, session?: import('mongoose').ClientSession): Promise<number> {
    const s = await this.stores.findOneAndUpdate({ _id: storeId }, { $inc: { tabSeq: 1 } }, { returnDocument: 'after', session });
    return s!.tabSeq;
  }

  /** Próximo número de pedido da loja (#1001...). */
  async nextOrderNumber(storeId: Types.ObjectId, session?: import('mongoose').ClientSession): Promise<number> {
    const s = await this.stores.findOneAndUpdate({ _id: storeId }, { $inc: { orderSeq: 1 } }, { returnDocument: 'after', session });
    return s!.orderSeq;
  }
}

const minOrNull = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
