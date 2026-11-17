import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { isDuplicateKeyError } from '../common/mongo';
import { CustomerService } from '../customer/customer.service';
import { ProductService } from '../products/product.service';
import { SaleService } from '../sale/sale.service';
import { Sale, SaleDocument } from '../sale/schema/sale.schema';
import { ExchangeCreateDto, ExchangeQuoteDto } from './dto';
import { deadlineOf, ExchangeError, parseSaleCode, paidByLine, priceReturns, saleCode, settle, withinWindow } from './exchange.rules';
import { Exchange, ExchangeDocument } from './schema/exchange.schema';

type Who = { id: string; name: string } | null;
/** Até onde a busca pelo comprovante olha (fora do prazo também acha, para dizer que passou do prazo). */
const LOOKUP_DAYS = 120;

/**
 * Trocas e devoluções no balcão (regras em exchange.rules.ts). Tudo numa transação: o estoque dos itens devolvidos
 * volta, os produtos novos viram uma venda (mesmas regras da tela de vendas: estoque, promoção, adicionais), a sobra
 * abate o fiado / vira crédito do cliente / volta em dinheiro, e a troca fica registrada para sempre.
 */
@Injectable()
export class ExchangeService {
  constructor(
    @InjectModel(Exchange.name) private readonly exchanges: Model<Exchange>,
    @InjectModel(Sale.name) private readonly saleModel: Model<Sale>,
    @InjectConnection() private readonly connection: Connection,
    private readonly sales: SaleService,
    private readonly products: ProductService,
    private readonly customers: CustomerService,
  ) {}

  private fail(e: unknown): never {
    if (e instanceof ExchangeError) throw new UnprocessableEntityException({ statusCode: 422, code: e.code, message: e.message });
    throw e;
  }

  /** A venda do comprovante (pelo código impresso ou pelo id). 404 se não achar nesta loja. */
  private async findSale(eid: string, raw: string): Promise<SaleDocument> {
    const q = parseSaleCode(raw);
    if (!q) throw new BadRequestException({ statusCode: 400, code: 'SALE_CODE_INVALID', message: 'Digite o número do comprovante: os 6 caracteres depois de "Nº" (ex.: 6E6770).' });
    if ('id' in q) {
      const s = await this.saleModel.findOne({ _id: q.id, enterpriseId: eid });
      if (!s) throw new NotFoundException('Nenhuma venda com esse comprovante nesta loja');
      return s;
    }
    const since = new Date(Date.now() - LOOKUP_DAYS * 86_400_000);
    const found = await this.saleModel.aggregate<{ _id: Types.ObjectId }>([
      { $match: { enterpriseId: new Types.ObjectId(eid), createdAt: { $gte: since } } },
      { $match: { $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${q.code}$`, options: 'i' } } } },
      { $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { _id: 1 } },
    ]);
    if (!found.length) throw new NotFoundException(`Nenhuma venda com o comprovante Nº ${q.code.toUpperCase()} nos últimos ${LOOKUP_DAYS} dias`);
    return (await this.saleModel.findOne({ _id: found[0]._id, enterpriseId: eid }))!;
  }

  /** Por que essa venda não pode ser trocada (ou null). */
  private blocker(sale: SaleDocument, now = new Date()): string | null {
    if (sale.status !== 'completed') return 'Esta venda foi cancelada.';
    if (sale.channel === 'online') return 'Compra da loja online: a devolução é feita pelo pedido, em Loja online → Pedidos.';
    if (!withinWindow(sale.createdAt!, now)) return `Passou do prazo de troca: a compra foi em ${fmtDate(sale.createdAt!)} e dava para trocar até ${fmtDate(deadlineOf(sale.createdAt!))}.`;
    return null;
  }

  private done(eid: string, saleId: Types.ObjectId, session?: ClientSession) {
    return this.exchanges.find({ enterpriseId: eid, saleId }).sort({ createdAt: 1 }).session(session ?? null).lean();
  }

  /** O que o caixa vê ao digitar o comprovante: os itens, quanto foi pago por cada um e quanto ainda pode voltar. */
  async lookup(eid: string, code: string) {
    const sale = await this.findSale(eid, code);
    const done = await this.done(eid, sale._id);
    const paid = paidByLine(sale.items, sale.discountCents ?? 0);
    const back = new Map<number, number>();
    for (const x of done) for (const r of x.returned) back.set(r.line, (back.get(r.line) ?? 0) + r.quantity);
    const customer = sale.customerId ? await this.customers.getCustomerById(eid, String(sale.customerId)).catch(() => null) : null;
    const blocked = this.blocker(sale);
    return {
      sale: {
        id: String(sale._id), code: saleCode(String(sale._id)), createdAt: sale.createdAt, totalCents: sale.totalCents, discountCents: sale.discountCents ?? 0,
        paymentMethod: sale.paymentMethod, status: sale.status, staffName: sale.staff?.name ?? '',
        customer: customer ? { id: String(customer._id), name: customer.name, creditCents: customer.creditCents ?? 0, debitCents: customer.debitCents ?? 0 } : null,
      },
      lines: sale.items.map((it, line) => {
        const returnedQty = back.get(line) ?? 0;
        return {
          line, productId: String(it.productId), productName: it.productName, productCode: it.productCode, quantity: it.quantity,
          unitPriceCents: it.unitPriceCents, paidCents: paid[line], paidUnitCents: Math.round(paid[line] / it.quantity),
          returnedQty, returnableQty: Math.max(0, it.quantity - returnedQty), options: it.options ?? [], note: it.note ?? '', stockTracked: it.stockTracked !== false,
        };
      }),
      deadline: deadlineOf(sale.createdAt!), eligible: !blocked, reason: blocked,
      exchanges: done.map((x) => this.present(x)),
    };
  }

  /** Prévia dos valores (o caixa vê antes de confirmar). Não reserva nada. */
  async quote(eid: string, dto: ExchangeQuoteDto) {
    const sale = await this.saleModel.findOne({ _id: dto.saleId, enterpriseId: eid });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    const blocked = this.blocker(sale);
    if (blocked) throw new ConflictException({ statusCode: 409, code: 'EXCHANGE_NOT_ALLOWED', message: blocked });
    let returned;
    try { returned = priceReturns(sale, await this.doneLines(eid, sale._id), dto.returns); } catch (e) { this.fail(e); }
    const newCents = dto.items?.length ? (await this.sales.quote(eid, dto.items)).totalCents : 0;
    const debt = await this.openDebt(eid, sale);
    return settle(returned.returnedCents, newCents, debt);
  }

  private async doneLines(eid: string, saleId: Types.ObjectId, session?: ClientSession) {
    return (await this.done(eid, saleId, session)).flatMap((x) => x.returned.map((r) => ({ line: r.line, quantity: r.quantity, totalCents: r.totalCents })));
  }

  /** Fiado em aberto que a sobra abate: só quando a venda original foi no fiado. */
  private async openDebt(eid: string, sale: SaleDocument, session?: ClientSession) {
    if (sale.paymentMethod !== 'fiado' || !sale.customerId) return 0;
    const c = await this.customers.getCustomerById(eid, String(sale.customerId)).catch(() => null);
    void session;
    return c?.debitCents ?? 0;
  }

  async create(eid: string, dto: ExchangeCreateDto, who: Who, idempotencyKey?: string) {
    if (idempotencyKey) {
      const prev = await this.exchanges.findOne({ enterpriseId: eid, idempotencyKey });
      if (prev) return this.present(prev);
    }
    const sale0 = await this.saleModel.findOne({ _id: dto.saleId, enterpriseId: eid });
    if (!sale0) throw new NotFoundException('Venda não encontrada');
    const blocked = this.blocker(sale0);
    if (blocked) throw new ConflictException({ statusCode: 409, code: 'EXCHANGE_NOT_ALLOWED', message: blocked });
    if (!dto.returns.length) throw new BadRequestException('Escolha ao menos um item para devolver');

    // Cliente que recebe o crédito (se sobrar): o escolhido no caixa ou o da venda original.
    const creditCustomer = dto.customerId ?? (sale0.customerId ? String(sale0.customerId) : null);
    if (creditCustomer) await this.customers.getCustomerById(eid, creditCustomer);
    const newItems = dto.items ?? [];
    const saleDto = { paymentMethod: dto.payMethod ?? 'cash', items: newItems, ...(creditCustomer ? { customerId: creditCustomer } : {}), ...(dto.cashReceivedCents != null ? { cashReceivedCents: dto.cashReceivedCents } : {}) } as Parameters<SaleService['prepare']>[1];
    const prep = newItems.length ? await this.sales.prepare(eid, saleDto, who) : null;

    const exchangeId = new Types.ObjectId();
    const session = await this.connection.startSession();
    try {
      let out!: ExchangeDocument;
      await session.withTransaction(async () => {
        // Relê dentro da transação: a venda e as trocas anteriores podem ter mudado.
        const sale = await this.saleModel.findOne({ _id: sale0._id, enterpriseId: eid }).session(session);
        if (!sale) throw new NotFoundException('Venda não encontrada');
        const now = new Date();
        const b = this.blocker(sale, now);
        if (b) throw new ConflictException({ statusCode: 409, code: 'EXCHANGE_NOT_ALLOWED', message: b });
        let priced;
        try { priced = priceReturns(sale, await this.doneLines(eid, sale._id, session), dto.returns); } catch (e) { this.fail(e); }

        // Trava da venda: uma troca concorrente da mesma venda esbarra aqui e recomeça (recalculando o que ainda pode voltar).
        await this.saleModel.updateOne({ _id: sale._id, enterpriseId: eid }, { $inc: { returnedCents: priced.returnedCents } }, { session });

        // Estoque dos itens devolvidos volta.
        const returned = priced.lines.map((r) => {
          const it = sale.items[r.line];
          return { line: r.line, productId: it.productId, productName: it.productName, productCode: it.productCode, quantity: r.quantity, totalCents: r.totalCents, stockTracked: it.stockTracked !== false };
        });
        for (const r of returned) if (r.stockTracked) await this.products.increaseQuantity(eid, String(r.productId), r.quantity, session);

        // Produtos novos: uma venda, paga primeiro com o valor devolvido.
        const newSale = prep ? await this.sales.write(eid, saleDto, prep, session, { saleId: new Types.ObjectId(), staff: who, exchange: { id: exchangeId, cents: priced.returnedCents } }) : null;
        const st = settle(priced.returnedCents, newSale?.totalCents ?? 0, await this.openDebt(eid, sale, session));

        if (st.debtAbatedCents > 0) await this.customers.reduceDebitUpTo(eid, String(sale.customerId), st.debtAbatedCents, session);
        let creditCents = 0, refundCents = 0;
        if (st.creditOrRefundCents > 0) {
          if (dto.leftover === 'credit') {
            if (!creditCustomer) throw new BadRequestException({ statusCode: 400, code: 'EXCHANGE_CUSTOMER_REQUIRED', message: 'Para guardar o valor como crédito, escolha o cliente cadastrado.' });
            await this.customers.addCredit(eid, creditCustomer, st.creditOrRefundCents, { kind: 'troca', exchangeId, by: who }, session);
            creditCents = st.creditOrRefundCents;
          } else if (dto.leftover === 'refund') {
            refundCents = st.creditOrRefundCents;
          } else throw new BadRequestException({ statusCode: 400, code: 'EXCHANGE_LEFTOVER_REQUIRED', message: 'Sobrou valor: escolha entre crédito para o cliente ou devolver o dinheiro.' });
        }

        [out] = await this.exchanges.create([{
          _id: exchangeId, enterpriseId: eid, saleId: sale._id, saleCode: saleCode(String(sale._id)), saleAt: sale.createdAt, customerId: creditCustomer ? new Types.ObjectId(creditCustomer) : sale.customerId ?? null,
          returned, returnedCents: priced.returnedCents, newSaleId: newSale?._id ?? null, newCents: newSale?.totalCents ?? 0,
          toPayCents: st.toPayCents, payMethod: st.toPayCents > 0 ? newSale?.paymentMethod ?? null : null,
          debtAbatedCents: st.debtAbatedCents, creditCents, refundCents, refundMethod: refundCents > 0 ? dto.refundMethod ?? 'cash' : null,
          reason: (dto.reason ?? '').trim().slice(0, 200),
          staff: who ? { id: new Types.ObjectId(who.id), name: who.name } : { name: 'Dono' },
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }], { session });
      });
      return this.present(out);
    } catch (e) {
      if (idempotencyKey && isDuplicateKeyError(e)) {
        const prev = await this.exchanges.findOne({ enterpriseId: eid, idempotencyKey });
        if (prev) return this.present(prev);
      }
      throw e;
    } finally {
      await session.endSession();
    }
  }

  async list(eid: string, page = 1, limit = 20) {
    const [rows, total] = await Promise.all([
      this.exchanges.find({ enterpriseId: eid }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.exchanges.countDocuments({ enterpriseId: eid }),
    ]);
    const names = await this.customerNames(eid, rows.map((r) => r.customerId).filter(Boolean) as Types.ObjectId[]);
    return { items: rows.map((r) => ({ ...this.present(r), customerName: r.customerId ? names.get(String(r.customerId)) ?? '' : '' })), total, page, limit };
  }

  async get(eid: string, id: string) {
    const x = await this.exchanges.findOne({ _id: id, enterpriseId: eid }).lean();
    if (!x) throw new NotFoundException('Troca não encontrada');
    const names = await this.customerNames(eid, x.customerId ? [x.customerId] : []);
    return { ...this.present(x), customerName: x.customerId ? names.get(String(x.customerId)) ?? '' : '' };
  }

  private async customerNames(eid: string, ids: Types.ObjectId[]) {
    const out = new Map<string, string>();
    for (const id of new Set(ids.map(String))) { const c = await this.customers.getCustomerById(eid, id).catch(() => null); if (c) out.set(id, c.name); }
    return out;
  }

  present(x: Exchange & { _id: Types.ObjectId | string; createdAt?: Date }) {
    return {
      id: String(x._id), code: saleCode(String(x._id)), createdAt: x.createdAt, saleId: String(x.saleId), saleCode: x.saleCode, saleAt: x.saleAt,
      customerId: x.customerId ? String(x.customerId) : null,
      returned: x.returned.map((r) => ({ line: r.line, productId: String(r.productId), productName: r.productName, productCode: r.productCode, quantity: r.quantity, totalCents: r.totalCents })),
      returnedCents: x.returnedCents, newSaleId: x.newSaleId ? String(x.newSaleId) : null, newCents: x.newCents,
      toPayCents: x.toPayCents, payMethod: x.payMethod, debtAbatedCents: x.debtAbatedCents, creditCents: x.creditCents, refundCents: x.refundCents, refundMethod: x.refundMethod,
      reason: x.reason, staffName: x.staff?.name ?? 'Dono',
    };
  }
}

const fmtDate = (d: Date) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
