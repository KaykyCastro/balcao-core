import { Logger } from '@nestjs/common';
import { Model, type Schema } from 'mongoose';

/**
 * Isolamento entre lojas no banco (o equivalente ao RLS do PostgreSQL, que o MongoDB não tem).
 *
 * Em toda coleção que tem `enterpriseId`, cada consulta, alteração, exclusão, contagem e agregação precisa dizer de
 * qual loja é (filtro por `enterpriseId`). Quem precisa atravessar lojas de propósito declara o motivo:
 *   crossTenant(this.orders, 'conta do comprador: os pedidos dele em todas as lojas').find({ shopperId })
 *   crossTenant(this.sales, 'admin: totais da plataforma').aggregate([...])
 * (a marca fica no objeto da consulta; nada extra vai para o banco).
 *
 * TENANT_GUARD=strict recusa a consulta (erro); warn (padrão) só registra no log, uma vez por ponto do código;
 * off desliga. O tenant vem sempre do token (@CurrentEnterprise), nunca do corpo da requisição.
 */
export type TenantMode = 'off' | 'warn' | 'strict';
export const tenantMode = (v = process.env.TENANT_GUARD): TenantMode => (v === 'off' || v === 'strict' ? v : 'warn');

const QUERY_OPS = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'distinct', 'replaceOne'] as const;
const log = new Logger('IsolamentoLojas');
const seen = new Set<string>();

export class TenantScopeError extends Error {
  constructor(public readonly where: string) { super(`Consulta sem enterpriseId em ${where}`); }
}

/** O filtro limita a uma loja? (`enterpriseId` no nível de cima ou dentro de um $and). */
export function scopedFilter(f: unknown): boolean {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  if (o.enterpriseId !== undefined && o.enterpriseId !== null) {
    const v = o.enterpriseId as Record<string, unknown>;
    // { $exists }, { $ne } ou { $nin } não limitam a uma loja.
    return !(typeof v === 'object' && !Array.isArray(v) && ('$exists' in v || '$ne' in v || '$nin' in v));
  }
  return Array.isArray(o.$and) && o.$and.some(scopedFilter);
}

// O hook do mongoose roda depois de a chamada original sair da pilha: guarda a origem quando o código cria a consulta
// (Model.find, Model.updateOne... são chamados de forma síncrona pelo serviço, então a pilha ainda tem quem chamou).
const SITE = Symbol('tenantSite');
const CROSS = Symbol('crossTenant');

/**
 * Exceção declarada: as consultas criadas por este model atravessam lojas de propósito (admin, rotinas, webhooks,
 * vitrine pública, conta do comprador). O motivo é obrigatório e fica no código, para revisão.
 */
export function crossTenant<M extends object>(model: M, reason: string): M {
  if (!reason.trim()) throw new Error('crossTenant precisa de um motivo');
  return new Proxy(model, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function' || !(STATICS as readonly (string | symbol)[]).includes(prop)) return v;
      return (...a: unknown[]) => { const q = (v as (...x: unknown[]) => Record<symbol, string>).apply(target, a); if (q && typeof q === 'object') q[CROSS] = reason; return q; };
    },
  });
}
const STATICS = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'distinct', 'replaceOne', 'aggregate'] as const;
for (const name of STATICS) {
  const M = Model as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = M[name];
  M[name] = function (this: unknown, ...a: unknown[]) {
    const q = orig.apply(this, a) as Record<symbol, string> | undefined;
    if (q && typeof q === 'object' && tenantMode() !== 'off') q[SITE] = new Error().stack ?? '';
    return q;
  };
}

/** Onde no código a consulta nasceu (primeira linha fora do mongoose e deste arquivo). */
function callSite(stack?: string): string {
  const lines = (stack ?? new Error().stack ?? '').split('\n').slice(1);
  const ours = lines.find((l) => !/node_modules|tenant-guard|node:internal/.test(l));
  return (ours ?? lines[0] ?? '').trim().replace(/^at\s+/, '').replace(/\(.*?(src[\\/][^)]+)\)/, '($1)');
}

export function check(model: string, op: string, filter: unknown, opts: Record<string, unknown> | undefined, mode = tenantMode(), stack?: string, cross?: string) {
  if (mode === 'off' || cross || opts?.crossTenant || scopedFilter(filter)) return;
  const where = `${model}.${op} ← ${callSite(stack)}`;
  if (mode === 'strict') throw new TenantScopeError(where);
  if (!seen.has(where)) { seen.add(where); log.warn(`Consulta sem enterpriseId (sem crossTenant declarado): ${where}`); }
}

/** Plugin para a conexão: vale para todos os schemas que têm o campo `enterpriseId`. */
export function tenantGuard(schema: Schema) {
  if (!schema.path('enterpriseId')) return;
  for (const op of QUERY_OPS) {
    schema.pre(op, function (this: { getFilter(): unknown; getOptions(): Record<string, unknown>; model: { modelName: string }; [SITE]?: string; [CROSS]?: string }) {
      check(this.model.modelName, op, this.getFilter(), this.getOptions(), tenantMode(), this[SITE], this[CROSS]);
    });
  }
  (schema as unknown as { pre(op: 'aggregate', fn: (this: { pipeline(): Record<string, unknown>[]; options: Record<string, unknown>; _model?: { modelName: string }; [SITE]?: string; [CROSS]?: string }) => void): void }).pre('aggregate', function () {
    const first = this.pipeline()[0];
    check(this._model?.modelName ?? 'aggregate', 'aggregate', first?.$match, this.options, tenantMode(), this[SITE], this[CROSS]);
  });
}
