import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { validateEnv } from '../common/config/env';
import { tenantGuard } from '../common/security/tenant-guard.plugin';
import { CategorySchema, CategorySchemaFactory } from '../category/schema/category.schema';
import { CustomerPayment, CustomerPaymentSchemaFactory } from '../customer/schema/customer-payment.schema';
import { CustomerSchema, CustomerSchemaFactory } from '../customer/schema/customer.schema';
import { EnterpriseSchema, EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';

/** Só o necessário para importar (sem agendadores nem rotas), com a mesma criptografia e o mesmo isolamento da API. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: (env) => { validateEnv(env as NodeJS.ProcessEnv); return env; } }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({ uri: c.get<string>('MONGO_URI') ?? c.get<string>('MONGO_DB'), autoIndex: true, connectionFactory: (conn: Connection) => { conn.plugin(tenantGuard); return conn; } }),
    }),
    MongooseModule.forFeature([
      { name: EnterpriseSchema.name, schema: EnterpriseSchemaFactory },
      { name: CategorySchema.name, schema: CategorySchemaFactory },
      { name: ProductSchema.name, schema: ProductSchemaFactory },
      { name: CustomerSchema.name, schema: CustomerSchemaFactory },
      { name: CustomerPayment.name, schema: CustomerPaymentSchemaFactory },
      { name: Sale.name, schema: SaleSchemaFactory },
    ]),
  ],
})
export class LegacyImportModule {}

/** Formato gerado por scripts/legado-converter.py (versão 1). Dinheiro em centavos. */
export interface LegacyData {
  versao: 1;
  categorias: { ref: number; nome: string }[];
  produtos: { ref: number; nome: string; codigo: string; categoriaRef: number; precoCentavos: number; precoPromoCentavos: number | null; descontoPct: number; estoque: number }[];
  clientes: { ref: number; nome: string; telefone: string; endereco: string; dividaCentavos: number }[];
  vendas: { ref: number; data: string; metodo: 'pix' | 'cash' | 'card' | 'fiado' | 'other'; cartao: 'credito' | 'debito' | null; clienteRef: number | null; totalCentavos: number; itens: { produtoRef: number; quantidade: number; precoUnitCentavos: number }[] }[];
  pagamentos: { ref: string; clienteRef: number; valorCentavos: number; data: string }[];
}
export interface LegacyReport { loja: string; simulacao: boolean; criados: Record<string, number>; jaExistiam: Record<string, number>; avisos: string[] }

/**
 * Grava os dados de um sistema antigo numa loja do Balcão. Pode rodar de novo: o que já existe é pulado (categoria
 * pelo nome, produto pelo código, cliente pelo nome, venda pela chave `legado:<id>`, pagamento por cliente+valor+data).
 * Nada passa pelo SaleService: o histórico não gera taxa do Balcão nem mexe no estoque (o estoque vem do backup).
 * Clientes já cadastrados na loja não têm a dívida alterada.
 */
export async function importLegacy(app: INestApplicationContext, data: LegacyData, opts: { email: string; dry: boolean }, log = new Logger('ImportacaoLegado')): Promise<LegacyReport> {
  if (data.versao !== 1) throw new Error('Arquivo de dados em versão desconhecida');
  const m = <T>(name: string) => app.get<Model<T>>(getModelToken(name));
  const enterprises = m<EnterpriseSchema>(EnterpriseSchema.name), categories = m<CategorySchema>(CategorySchema.name), products = m<ProductSchema>(ProductSchema.name);
  const customers = m<CustomerSchema>(CustomerSchema.name), payments = m<CustomerPayment>(CustomerPayment.name), sales = m<Sale>(Sale.name);

  const ent = await enterprises.findOne({ email: opts.email.trim().toLowerCase() }).select('_id name email').lean();
  if (!ent) throw new Error(`Nenhuma loja com o e-mail ${opts.email}`);
  const eid = new Types.ObjectId(String(ent._id));
  const rep: LegacyReport = { loja: `${ent.name} (${ent.email})`, simulacao: opts.dry, criados: {}, jaExistiam: {}, avisos: [] };
  const made = (k: string) => { rep.criados[k] = (rep.criados[k] ?? 0) + 1; };
  const had = (k: string) => { rep.jaExistiam[k] = (rep.jaExistiam[k] ?? 0) + 1; };
  const fake = () => new Types.ObjectId(); // na simulação, ids de mentira só para seguir o mapeamento
  log.log(`${opts.dry ? 'SIMULAÇÃO' : 'GRAVANDO'} na loja ${rep.loja}`);

  // 1) Categorias (pelo nome)
  const catId = new Map<number, Types.ObjectId>();
  for (const c of data.categorias) {
    const ex = await categories.findOne({ enterpriseId: eid, name: c.nome }).select('_id').lean();
    if (ex) { catId.set(c.ref, new Types.ObjectId(String(ex._id))); had('categorias'); continue; }
    catId.set(c.ref, opts.dry ? fake() : (await categories.create({ name: c.nome, enterpriseId: eid }))._id as Types.ObjectId); made('categorias');
  }

  // 2) Produtos (pelo código, que é único por loja). Produto que já existe não é alterado.
  const prod = new Map<number, { id: Types.ObjectId; name: string; code: string; priceCents: number }>();
  for (const p of data.produtos) {
    const ex = await products.findOne({ enterpriseId: eid, code: p.codigo }).select('_id name code price').lean();
    if (ex) { prod.set(p.ref, { id: new Types.ObjectId(String(ex._id)), name: ex.name, code: ex.code, priceCents: Math.round(ex.price * 100) }); had('produtos'); continue; }
    const categoryId = catId.get(p.categoriaRef);
    if (!categoryId) { rep.avisos.push(`Produto ${p.codigo} sem categoria: pulado`); continue; }
    const doc = {
      name: p.nome, code: p.codigo, description: '', trackStock: true, quantity: p.estoque, price: p.precoCentavos / 100,
      priceWithDiscount: p.precoPromoCentavos ? p.precoPromoCentavos / 100 : 0, discountPercentage: p.precoPromoCentavos ? p.descontoPct : 0,
      categoryId, enterpriseId: eid,
    };
    const id = opts.dry ? fake() : (await products.create(doc))._id as Types.ObjectId;
    prod.set(p.ref, { id, name: p.nome, code: p.codigo, priceCents: p.precoCentavos }); made('produtos');
  }

  // 3) Clientes (pelo nome). Telefone e endereço são criptografados pelo próprio modelo.
  const cli = new Map<number, Types.ObjectId>();
  for (const c of data.clientes) {
    const ex = await customers.findOne({ enterpriseId: eid, name: c.nome }).select('_id debitCents').lean();
    if (ex) {
      cli.set(c.ref, new Types.ObjectId(String(ex._id))); had('clientes');
      if (ex.debitCents !== c.dividaCentavos) rep.avisos.push(`Cliente já cadastrado "${c.nome}": dívida no Balcão ${ex.debitCents / 100} × backup ${c.dividaCentavos / 100} (não alterada)`);
      continue;
    }
    const id = opts.dry ? fake() : (await customers.create({ name: c.nome, numberWithPrefix: c.telefone, address: c.endereco, debitCents: c.dividaCentavos, enterpriseId: eid, origin: 'pos' }))._id as Types.ObjectId;
    cli.set(c.ref, id); made('clientes');
  }

  // 4) Vendas (histórico): gravadas direto, com a data original, sem taxa e sem baixar estoque.
  for (const v of data.vendas) {
    const key = `legado:${v.ref}`;
    if (await sales.exists({ enterpriseId: eid, idempotencyKey: key })) { had('vendas'); continue; }
    const items = v.itens.flatMap((i) => {
      const p = prod.get(i.produtoRef);
      if (!p) { rep.avisos.push(`Venda ${v.ref}: produto ${i.produtoRef} não encontrado (item pulado)`); return []; }
      return [{ productId: p.id, productName: p.name, productCode: p.code, unitPriceCents: i.precoUnitCentavos, quantity: i.quantidade, totalCents: i.precoUnitCentavos * i.quantidade, stockTracked: true,
        ...(p.priceCents !== i.precoUnitCentavos ? { originalUnitPriceCents: p.priceCents } : {}) }];
    });
    const subtotal = items.reduce((s, i) => s + i.totalCents, 0);
    const when = new Date(v.data);
    const doc = {
      enterpriseId: eid, customerId: v.clienteRef ? cli.get(v.clienteRef) ?? null : null, paymentMethod: v.metodo, channel: 'pos', status: 'completed',
      items, totalCents: v.totalCentavos, subtotalCents: items.length ? Math.max(subtotal, v.totalCentavos) : v.totalCentavos,
      discountCents: items.length ? Math.max(0, subtotal - v.totalCentavos) : 0, cashReceivedCents: null, changeCents: null,
      idempotencyKey: key, createdAt: when, updatedAt: when,
    };
    if (!opts.dry) await new sales(doc).save({ timestamps: false });
    made('vendas');
  }

  // 5) Pagamentos do fiado (histórico; a dívida atual já veio do cadastro do cliente).
  for (const p of data.pagamentos) {
    const customerId = cli.get(p.clienteRef);
    if (!customerId) { rep.avisos.push(`Pagamento ${p.ref}: cliente não encontrado (pulado)`); continue; }
    const when = new Date(p.data);
    if (await payments.exists({ enterpriseId: eid, customerId, amountCents: p.valorCentavos, createdAt: when })) { had('pagamentos'); continue; }
    if (!opts.dry) await new payments({ enterpriseId: eid, customerId, amountCents: p.valorCentavos, method: 'other', createdAt: when }).save({ timestamps: false });
    made('pagamentos');
  }
  return rep;
}
