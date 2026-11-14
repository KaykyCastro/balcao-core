import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PosConfig, PosPayment, PosPaymentDocument, type PosProvider } from './schema/pos.schema';
import { PosChargeDto, PosConfigDto, TapResultDto } from './dto';
import { randomBytes } from 'crypto';
import { digits, docOk, HANDLE_RE, judgeTapResult, maxInstallments, normalizeHandle, returnUrlOk, tapDeeplink } from './tap.rules';
import { StoneClient } from './stone.client';
import { MercadoPagoClient } from '../mercadopago/mercadopago.client';
import { SaleService } from '../sale/sale.service';
import { StoreService } from '../store/store.service';
import { EnterpriseService } from '../enterprise/enterprise.service';
import { CustomerService } from '../customer/customer.service';
import { normalizePixKey, pixPayload } from '../common/pix';
import { open, seal } from '../common/secret-box';
import { isDuplicateKeyError } from '../common/mongo';
import { TabService } from '../store/tab.service';
import { crossTenant } from '../common/security/tenant-guard.plugin';

const MIN = 60_000;
const TTL: Record<PosProvider, number> = { mp_point: 15 * MIN, stone: 15 * MIN, mp_pix: 30 * MIN, pix_key: 30 * MIN, infinitetap: 15 * MIN };
export const PROVIDER_LABEL: Record<PosProvider, string> = { mp_point: 'Maquininha Mercado Pago', stone: 'Maquininha Stone', mp_pix: 'Pix (Mercado Pago)', pix_key: 'Pix na chave da loja', infinitetap: 'Celular (InfiniteTap)' };

/**
 * Cobrança no balcão: manda o valor para a maquininha (Mercado Pago Point ou Stone) ou mostra o QR do Pix.
 * A venda (com comprovante e baixa no estoque) só nasce quando o pagamento é confirmado.
 */
@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);
  constructor(
    @InjectModel(PosConfig.name) private readonly configs: Model<PosConfig>,
    @InjectModel(PosPayment.name) private readonly payments: Model<PosPayment>,
    private readonly mp: MercadoPagoClient,
    private readonly stone: StoneClient,
    private readonly sales: SaleService,
    private readonly stores: StoreService,
    private readonly enterprises: EnterpriseService,
    private readonly customers: CustomerService,
    private readonly tabs: TabService,
  ) {}

  // ------------------------------------------------------------------ configuração

  private async cfg(eid: string, withSecret = false) {
    const q = this.configs.findOne({ enterpriseId: new Types.ObjectId(eid) });
    if (withSecret) q.select('+stone.skSealed');
    return (await q.lean()) ?? { pix: { mode: 'off', keyType: 'cnpj', key: '', holder: '', city: '' }, point: { enabled: false, terminalId: '', label: '' }, stone: { enabled: false, serial: '', skHint: '', skSealed: null }, tap: { enabled: false, handle: '', doc: '' } } as unknown as PosConfig;
  }

  private async mpToken(eid: string): Promise<string | null> {
    const s = await this.stores.getOrCreate(eid);
    if (!s.mp?.userId) return null;
    return this.stores.mpAccessToken(s._id);
  }

  async view(eid: string) {
    const [c, store] = await Promise.all([this.cfg(eid), this.stores.getOrCreate(eid)]);
    const mpConnected = !!store.mp?.userId;
    const pixKeyOk = c.pix?.mode === 'key' && !!normalizePixKey(c.pix.keyType, c.pix.key) && !!c.pix.holder;
    const stoneOk = !!(c.stone?.enabled && c.stone.serial && c.stone.skHint && this.stone.partnerReady);
    const pointOk = !!(c.point?.enabled && c.point.terminalId && mpConnected);
    const tapOk = !!(c.tap?.enabled && c.tap.handle);
    return {
      pix: { mode: c.pix?.mode ?? 'off', keyType: c.pix?.keyType ?? 'cnpj', key: c.pix?.key ?? '', holder: c.pix?.holder ?? '', city: c.pix?.city ?? '' },
      point: { enabled: !!c.point?.enabled, terminalId: c.point?.terminalId ?? '', label: c.point?.label ?? '' },
      stone: { enabled: !!c.stone?.enabled, serial: c.stone?.serial ?? '', skHint: c.stone?.skHint ?? '', partnerReady: this.stone.partnerReady },
      tap: { enabled: !!c.tap?.enabled, handle: c.tap?.handle ?? '', doc: c.tap?.doc ?? '' },
      mp: { connected: mpConnected, nickname: store.mp?.nickname ?? '' },
      /** O que o caixa pode usar agora, na ordem de preferência. */
      available: {
        card: [...(pointOk ? ['mp_point'] : []), ...(stoneOk ? ['stone'] : []), ...(tapOk ? ['infinitetap'] : [])] as PosProvider[],
        pix: [...(c.pix?.mode === 'mercadopago' && mpConnected ? ['mp_pix'] : []), ...(pixKeyOk ? ['pix_key'] : []), ...(pointOk ? ['mp_point'] : []), ...(stoneOk ? ['stone'] : [])] as PosProvider[],
      },
    };
  }

  async update(eid: string, dto: PosConfigDto) {
    const set: Record<string, unknown> = {};
    if (dto.pix) {
      const cur = await this.cfg(eid);
      const p = { ...cur.pix, ...Object.fromEntries(Object.entries(dto.pix).filter(([, v]) => v !== undefined)) } as PosConfig['pix'];
      if (p.mode === 'key') {
        const k = normalizePixKey(p.keyType, p.key ?? '');
        if (!k) throw new UnprocessableEntityException('Chave Pix inválida para o tipo escolhido');
        if (!p.holder?.trim()) throw new UnprocessableEntityException('Informe o nome do recebedor (como aparece no banco)');
        p.key = k;
      }
      if (p.mode === 'mercadopago' && !(await this.stores.getOrCreate(eid)).mp?.userId) throw new UnprocessableEntityException('Conecte a conta do Mercado Pago antes (Loja online → Pagamento)');
      set.pix = { mode: p.mode, keyType: p.keyType, key: p.key ?? '', holder: (p.holder ?? '').trim(), city: (p.city ?? '').trim() };
    }
    if (dto.point) for (const [k, v] of Object.entries(dto.point)) if (v !== undefined) set[`point.${k}`] = typeof v === 'string' ? v.trim() : v;
    if (dto.stone) {
      if (dto.stone.enabled !== undefined) set['stone.enabled'] = dto.stone.enabled;
      if (dto.stone.serial !== undefined) set['stone.serial'] = dto.stone.serial.trim();
      if (dto.stone.secretKey !== undefined) { const k = dto.stone.secretKey.trim(); set['stone.skSealed'] = k ? seal(k) : null; set['stone.skHint'] = k ? `…${k.slice(-4)}` : ''; }
    }
    if (dto.tap) {
      const cur = (await this.cfg(eid)).tap ?? { enabled: false, handle: '', doc: '' };
      const handle = dto.tap.handle !== undefined ? normalizeHandle(dto.tap.handle) : cur.handle;
      const doc = dto.tap.doc !== undefined ? digits(dto.tap.doc) : cur.doc;
      const enabled = dto.tap.enabled ?? cur.enabled;
      if (handle && !HANDLE_RE.test(handle)) throw new UnprocessableEntityException('InfiniteTag inválida: use letras, números, ponto, traço ou sublinhado');
      if (!docOk(doc)) throw new UnprocessableEntityException('Documento da conta InfinitePay: CPF (11 números) ou CNPJ (14 números)');
      if (enabled && !handle) throw new UnprocessableEntityException('Informe a InfiniteTag da conta InfinitePay para ligar o Tap');
      set.tap = { enabled, handle, doc };
    }
    if (Object.keys(set).length) await this.configs.updateOne({ enterpriseId: new Types.ObjectId(eid) }, { $set: set }, { upsert: true });
    return this.view(eid);
  }

  async terminals(eid: string) {
    const token = await this.mpToken(eid);
    if (!token) throw new ConflictException('Conecte a conta do Mercado Pago antes (Loja online → Pagamento)');
    return this.mp.terminals(token);
  }

  async setPdv(eid: string, terminalId: string) {
    const token = await this.mpToken(eid);
    if (!token) throw new ConflictException('Conecte a conta do Mercado Pago antes (Loja online → Pagamento)');
    await this.mp.setPdvMode(token, terminalId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ cobrança

  async charge(eid: string, dto: PosChargeDto, staff: { id: string; name: string } | null = null) {
    const eoid = new Types.ObjectId(eid);
    if (dto.clientKey) { const prev = await this.payments.findOne({ enterpriseId: eoid, clientKey: dto.clientKey }); if (prev) return this.present(prev); }
    if (dto.method !== 'pix' && (dto.provider === 'mp_pix' || dto.provider === 'pix_key')) throw new BadRequestException('Pix só cobra Pix');
    if (dto.customerId) await this.customers.getCustomerById(eid, dto.customerId);
    const { totalCents } = dto.tabId ? { totalCents: await this.tabs.amountDue(eid, dto.tabId) } : await this.sales.quote(eid, dto.items, dto.discount, staff);
    if (totalCents < 1) throw new UnprocessableEntityException('Total zerado: nada para cobrar');
    const c = await this.cfg(eid, true);
    const id = new Types.ObjectId();
    const ref = `balcao-${id}`;
    const base = {
      _id: id, enterpriseId: eoid, provider: dto.provider, method: dto.method, installments: dto.method === 'credit' ? dto.installments ?? 1 : 1, amountCents: totalCents,
      items: dto.tabId ? [] : dto.items.map((i) => ({ productId: i.productId, quantity: i.quantity, ...(i.options?.length ? { options: i.options.map((o) => ({ g: o.g, i: o.i, q: o.q })) } : {}), ...(i.note?.trim() ? { note: i.note.trim() } : {}) })), ...(dto.discount && !dto.tabId ? { discount: dto.discount } : {}), tabId: dto.tabId ? new Types.ObjectId(dto.tabId) : null, staff, customerId: dto.customerId ? new Types.ObjectId(dto.customerId) : null,
      expiresAt: new Date(Date.now() + TTL[dto.provider]), ...(dto.clientKey ? { clientKey: dto.clientKey } : {}),
    };
    const ent = await this.enterprises.findEnterpriseById(eid);
    let extra: Partial<PosPayment> = {};
    if (dto.provider === 'pix_key') {
      if (c.pix?.mode !== 'key') throw new ConflictException('Configure a chave Pix em Configurações → Pagamentos no balcão');
      const key = normalizePixKey(c.pix.keyType, c.pix.key);
      if (!key) throw new ConflictException('Chave Pix inválida nas configurações');
      extra = { qrCode: pixPayload({ key, name: c.pix.holder || ent.name, city: c.pix.city || 'BRASIL', amountCents: totalCents, txid: String(id).slice(-25) }) };
    } else if (dto.provider === 'mp_pix' || dto.provider === 'mp_point') {
      const token = await this.mpToken(eid);
      if (!token) throw new ConflictException('Conecte a conta do Mercado Pago antes (Loja online → Pagamento)');
      if (dto.provider === 'mp_pix') {
        if (c.pix?.mode !== 'mercadopago') throw new ConflictException('Ative o Pix pelo Mercado Pago em Configurações → Pagamentos no balcão');
        const cust = dto.customerId ? await this.customers.getCustomerById(eid, dto.customerId).catch(() => null) : null;
        const email = (cust as { email?: string } | null)?.email || 'cliente.balcao@balcao.app';
        const o = await this.mp.createPixOrder({ accessToken: token, amountCents: totalCents, reference: ref, idem: `pos-${id}`, payerEmail: email, expiresMin: 30, statementDescriptor: ent.name });
        extra = { providerRef: o.id, qrCode: o.qrCode, qrBase64: o.qrBase64 };
      } else {
        if (!c.point?.enabled || !c.point.terminalId) throw new ConflictException('Escolha a maquininha Point em Configurações → Pagamentos no balcão');
        const type = dto.method === 'credit' ? 'credit_card' : dto.method === 'debit' ? 'debit_card' : 'qr';
        const o = await this.mp.createPointOrder({ accessToken: token, terminalId: c.point.terminalId, amountCents: totalCents, reference: ref, idem: `pos-${id}`, type, installments: base.installments, description: `Venda ${ent.name}` });
        extra = { providerRef: o.id };
      }
    } else if (dto.provider === 'infinitetap') {
      if (dto.method === 'pix') throw new BadRequestException('O Tap cobra só cartão (crédito ou débito)');
      if (!c.tap?.enabled || !c.tap.handle) throw new ConflictException('Ligue o Tap da InfinitePay em Configurações → Pagamentos no balcão');
      if (!dto.returnUrl || !returnUrlOk(dto.returnUrl, process.env.NODE_ENV !== 'production')) throw new BadRequestException('Endereço de retorno inválido para o Tap');
      if (totalCents < 100) throw new UnprocessableEntityException('O Tap da InfinitePay cobra a partir de R$ 1,00');
      if (base.installments > maxInstallments(totalCents)) throw new UnprocessableEntityException(`Em ${base.installments}x cada parcela ficaria abaixo de R$ 1,00`);
      // Segredo de uso único desta cobrança: só o retorno com ele vale (ver tap.rules.ts).
      const orderId = randomBytes(16).toString('hex');
      extra = { providerRef: orderId, deeplink: tapDeeplink({ amountCents: totalCents, method: dto.method, installments: base.installments, orderId, resultUrl: dto.returnUrl, handle: c.tap.handle, doc: c.tap.doc }) };
    } else {
      const sk = open(c.stone?.skSealed);
      if (!c.stone?.enabled || !sk || !c.stone.serial) throw new ConflictException('Configure a maquininha Stone em Configurações → Pagamentos no balcão');
      const o = await this.stone.createOrder({ sk, serial: c.stone.serial, amountCents: totalCents, reference: ref, type: dto.method, installments: base.installments, title: `Venda ${ent.name}` });
      extra = { providerRef: o.id };
    }
    try {
      const doc = await this.payments.create({ ...base, ...extra });
      return this.present(doc);
    } catch (e) {
      if (dto.clientKey && isDuplicateKeyError(e)) { const prev = await this.payments.findOne({ enterpriseId: eoid, clientKey: dto.clientKey }); if (prev) return this.present(prev); }
      throw e;
    }
  }

  private async one(eid: string, id: string) {
    const p = await this.payments.findOne({ _id: id, enterpriseId: new Types.ObjectId(eid) });
    if (!p) throw new NotFoundException('Cobrança não encontrada');
    return p;
  }

  /** Pergunta ao provedor como está; se pagou, registra a venda. O caixa chama a cada 2 s enquanto espera. */
  async status(eid: string, id: string) { return this.present(await this.sync(await this.one(eid, id))); }

  async sync(p: PosPaymentDocument): Promise<PosPaymentDocument> {
    if (p.status === 'paid' && !p.saleId) return this.finalize(p, {}); // pagou mas a venda não fechou: tenta de novo
    if (p.status !== 'pending') return p;
    const expired = Date.now() > p.expiresAt.getTime() + 2 * MIN;
    if (p.provider === 'pix_key') {
      if (expired) return this.fail(p, 'Tempo do QR Code esgotado', 'canceled');
      return p;
    }
    // InfiniteTap: não há como perguntar à InfinitePay; só o retorno no app paga (tapResult).
    if (p.provider === 'infinitetap') return expired ? this.fail(p, 'Tempo esgotado sem retorno da InfinitePay', 'canceled') : p;
    const eid = String(p.enterpriseId);
    try {
      if (p.provider === 'stone') {
        const sk = open((await this.cfg(eid, true)).stone?.skSealed);
        if (!sk) return p;
        const o = await this.stone.order(sk, p.providerRef);
        if (o.state === 'paid') { await this.stone.close(sk, p.providerRef, 'paid').catch(() => undefined); return this.finalize(p, { brand: o.brand, installments: o.installments, authCode: o.authCode, methodType: o.method }); }
        if (o.state === 'failed') return this.fail(p, 'Pagamento recusado ou cancelado na maquininha');
        if (expired) { await this.stone.close(sk, p.providerRef, 'canceled').catch(() => undefined); return this.fail(p, 'Tempo esgotado na maquininha', 'canceled'); }
        return p;
      }
      const token = await this.mpToken(eid);
      if (!token) return p;
      const o = await this.mp.order(token, p.providerRef);
      if (o.state === 'paid') return this.finalize(p, { paymentId: o.paymentId, brand: o.method, installments: o.installments, methodType: o.methodType });
      if (o.state === 'failed') return this.fail(p, o.statusDetail === 'expired' || o.status === 'expired' ? 'Tempo esgotado' : 'Pagamento recusado ou cancelado');
      if (expired) { await this.mp.cancelOrder(token, p.providerRef, `pos-cancel-${p._id}`).catch(() => undefined); return this.fail(p, 'Tempo esgotado', 'canceled'); }
    } catch (e) {
      this.logger.warn(`Consulta da cobrança ${p._id} falhou: ${(e as Error).message}`);
    }
    return p;
  }

  /** Pix na chave: o dinheiro cai direto no banco do lojista, então quem confirma é o caixa. */
  async confirm(eid: string, id: string, actor: string) {
    const p = await this.one(eid, id);
    if (p.provider !== 'pix_key') throw new BadRequestException('Só o Pix na chave da loja é confirmado à mão. Maquininha e Pix pelo Mercado Pago confirmam sozinhos.');
    if (p.status !== 'pending') return this.present(p);
    p.confirmedBy = actor;
    return this.present(await this.finalize(p, { methodType: 'pix' }));
  }

  /**
   * Retorno do InfiniteTap (o app repassa o que a InfinitePay mandou no deep link). Só paga a cobrança pendente desta
   * loja com o mesmo `order_id`, dentro do prazo, recebida na conta configurada e com um NSU nunca usado.
   */
  async tapResult(eid: string, id: string, dto: TapResultDto) {
    const p = await this.one(eid, id);
    if (p.provider !== 'infinitetap') throw new BadRequestException('Esta cobrança não é do Tap');
    // Mesmo retorno chegando de novo (app reaberto): devolve o resultado já registrado.
    if (p.status === 'paid' && p.detail?.paymentId && p.detail.paymentId === (dto.nsu ?? '').trim()) return this.present(p.saleId ? p : await this.finalize(p, {}));
    const tap = (await this.cfg(eid)).tap ?? { enabled: false, handle: '', doc: '' };
    const v = judgeTapResult({ orderId: p.providerRef, status: p.status, expiresAt: p.expiresAt }, tap, dto);
    if (!v.ok) {
      this.logger.warn(`Retorno do Tap recusado na cobrança ${p._id}: ${v.code}`);
      if (v.code === 'TAP_NOT_PAID') return this.present(await this.fail(p, v.reason));
      throw new ConflictException({ statusCode: 409, code: v.code, message: v.reason });
    }
    let paid: PosPaymentDocument | null;
    try {
      paid = await this.payments.findOneAndUpdate(
        { _id: p._id, status: 'pending', providerRef: p.providerRef },
        { $set: { status: 'paid', paidAt: new Date(), detail: { paymentId: v.nsu, authCode: v.aut, brand: v.brand, installments: p.installments, methodType: p.method } } },
        { new: true },
      );
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException({ statusCode: 409, code: 'TAP_NSU_USED', message: 'Esta transação da InfinitePay já pagou outra venda.' });
      throw e;
    }
    if (!paid) return this.present((await this.payments.findById(p._id))!);
    return this.present(await this.finalize(paid, {}));
  }

  async cancel(eid: string, id: string) {
    const p = await this.one(eid, id);
    if (p.status !== 'pending') return this.present(p);
    try {
      if (p.provider === 'mp_point' || p.provider === 'mp_pix') {
        const token = await this.mpToken(eid);
        if (token) {
          const o = await this.mp.cancelOrder(token, p.providerRef, `pos-cancel-${p._id}`).catch(async () => this.mp.order(token, p.providerRef));
          if (o.state === 'paid') return this.present(await this.finalize(p, { paymentId: o.paymentId, brand: o.method, installments: o.installments }));
        }
      } else if (p.provider === 'stone') {
        const sk = open((await this.cfg(eid, true)).stone?.skSealed);
        if (sk) {
          const o = await this.stone.order(sk, p.providerRef).catch(() => null);
          if (o?.state === 'paid') return this.present(await this.finalize(p, { brand: o.brand, installments: o.installments, authCode: o.authCode }));
          await this.stone.close(sk, p.providerRef, 'canceled').catch(() => undefined);
        }
      }
    } catch (e) {
      this.logger.warn(`Cancelamento da cobrança ${p._id} no provedor falhou: ${(e as Error).message}`);
    }
    return this.present(await this.fail(p, 'Cancelada no caixa', 'canceled'));
  }

  private async fail(p: PosPaymentDocument, reason: string, status: 'failed' | 'canceled' = 'failed') {
    const r = await this.payments.findOneAndUpdate({ _id: p._id, status: 'pending' }, { $set: { status, failReason: reason } }, { new: true });
    return r ?? (await this.payments.findById(p._id))!;
  }

  /** Pago: marca e registra a venda (idempotente pela chave pos:<id>; nunca cria duas vendas). */
  private async finalize(p: PosPaymentDocument, detail: NonNullable<PosPayment['detail']>) {
    const now = new Date();
    await this.payments.updateOne({ _id: p._id, status: { $in: ['pending', 'paid'] } }, { $set: { status: 'paid', paidAt: p.paidAt ?? now, detail: { ...(p.detail ?? {}), ...detail }, ...(p.confirmedBy ? { confirmedBy: p.confirmedBy } : {}) } });
    const cur = (await this.payments.findById(p._id))!;
    if (cur.saleId) return cur;
    try {
      if (p.tabId) {
        // Comanda de mesa: fecha a conta (a venda nasce dela, com os itens já lançados).
        const sale = await this.tabs.settleFromPos(String(p.enterpriseId), String(p.tabId), {
          provider: p.provider, method: p.method, installments: p.installments, amountCents: p.amountCents, reference: p.providerRef || String(p._id),
          paymentId: cur.detail?.paymentId ?? undefined, brand: cur.detail?.brand ?? undefined, paidAt: cur.paidAt ?? now, intentId: p._id,
        }, p.method === 'pix' ? 'pix' : 'card', p.staff ?? null);
        await this.payments.updateOne({ _id: p._id }, { $set: { saleId: sale._id, failReason: sale.totalCents !== p.amountCents ? `Valor da conta (${sale.totalCents}) diferente do cobrado (${p.amountCents})` : '' } });
        return (await this.payments.findById(p._id))!;
      }
      const sale = await this.sales.create(String(p.enterpriseId), {
        paymentMethod: p.method === 'pix' ? 'pix' : 'card', items: p.items.map((i) => ({ productId: String(i.productId), quantity: i.quantity, ...(i.options?.length ? { options: i.options.map((o) => ({ g: o.g, i: o.i, q: o.q })) } : {}), ...(i.note ? { note: i.note } : {}) })), ...(p.customerId ? { customerId: String(p.customerId) } : {}),
        ...(p.discount?.value ? { discount: { mode: p.discount.mode, value: p.discount.value, ...(p.discount.reason ? { reason: p.discount.reason } : {}) } } : {}),
      }, `pos:${p._id}`, {
        provider: p.provider, method: p.method, installments: p.installments, amountCents: p.amountCents, reference: p.providerRef || String(p._id),
        paymentId: cur.detail?.paymentId ?? undefined, brand: cur.detail?.brand ?? undefined, paidAt: cur.paidAt ?? now, intentId: p._id,
      }, p.staff ?? null);
      await this.payments.updateOne({ _id: p._id }, { $set: { saleId: sale._id, failReason: sale.totalCents !== p.amountCents ? `Valor da venda (${sale.totalCents}) diferente do cobrado (${p.amountCents})` : '' } });
    } catch (e) {
      // Pagou mas o estoque acabou no meio: o dinheiro entrou, a venda precisa de atenção do caixa.
      this.logger.error(`Cobrança ${p._id} paga, mas a venda falhou: ${(e as Error).message}`);
      await this.payments.updateOne({ _id: p._id }, { $set: { failReason: `Pago, mas a venda não foi registrada: ${(e as Error).message}` } });
    }
    return (await this.payments.findById(p._id))!;
  }

  /** Cobranças esquecidas na tela (caixa fechou a aba): confere com o provedor e fecha a venda se pagou. */
  async reconcile(): Promise<number> {
    const since = new Date(Date.now() - 3 * 3600_000);
    const rows = await crossTenant(this.payments, 'rotina: confere cobranças da maquininha de todas as lojas').find({ $or: [{ status: 'pending', provider: { $ne: 'pix_key' }, createdAt: { $gte: since } }, { status: 'paid', saleId: null, createdAt: { $gte: since } }, { status: 'pending', provider: 'pix_key', expiresAt: { $lt: new Date(Date.now() - 2 * MIN) } }] }).limit(200);
    let n = 0;
    for (const p of rows) { const before = p.status, hadSale = !!p.saleId; const r = await this.sync(p); if (r.status !== before || (r.saleId && !hadSale)) n++; }
    return n;
  }

  async present(p: PosPaymentDocument) {
    const sale = p.saleId ? await this.sales.findById(String(p.enterpriseId), String(p.saleId)).catch(() => null) : null;
    return {
      id: String(p._id), status: p.status, provider: p.provider, providerLabel: PROVIDER_LABEL[p.provider], method: p.method, installments: p.installments,
      amountCents: p.amountCents, qrCode: p.qrCode, qrBase64: p.qrBase64, deeplink: p.status === 'pending' ? p.deeplink ?? null : null, expiresAt: p.expiresAt, paidAt: p.paidAt, failReason: p.failReason,
      detail: p.detail ?? null, saleId: p.saleId ? String(p.saleId) : null, sale,
    };
  }
}
