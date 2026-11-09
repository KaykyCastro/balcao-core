import { createHmac } from 'crypto';
import type { Schema } from 'mongoose';
import { open, seal } from '../secret-box';

/**
 * Dados pessoais criptografados no banco (AES-256-GCM, chave SECRETS_KEY, a mesma dos tokens do Mercado Pago).
 * O valor guardado é "enc:v1:<iv>:<tag>:<cifra>"; a API lê e grava em claro, o banco só vê a cifra.
 * Valores antigos sem o prefixo continuam legíveis (o script `npm run encrypt:pii` converte o que já existe).
 *
 * Campo criptografado não serve para busca no banco: telefone de pedido ganha um índice cego (HMAC dos 8 últimos
 * dígitos) para achar o pedido pelo número completo. Nome e e-mail ficam em claro (login, busca e cupom dependem deles).
 */
export const ENC_PREFIX = 'enc:v1:';

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith(ENC_PREFIX);
export const encrypt = (v: unknown) => (typeof v === 'string' && v !== '' && !isEncrypted(v) ? ENC_PREFIX + seal(v) : v);
/** Valor ilegível (chave errada, cifra corrompida) vira '' em vez de vazar a cifra para a tela. */
export const decrypt = (v: unknown) => (isEncrypted(v) ? open(v.slice(ENC_PREFIX.length)) ?? '' : v);

/** Índice cego de telefone: o mesmo número gera o mesmo código, sem dar para voltar ao número. */
export function phoneIndex(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  const k = process.env.SECRETS_KEY || `balcao-idx:${process.env.JWT_SECRET ?? 'dev-only-secret'}`;
  return createHmac('sha256', `phone-idx:${k}`).update(d.slice(-8)).digest('hex').slice(0, 32);
}

/**
 * Caminhos com pontos; `[]` marca lista: 'phone', 'customer.phone', 'address.street', 'addresses[].street'.
 * `fn` é aplicado em cada valor encontrado (no lugar, em objetos comuns).
 */
export function mapPaths(obj: unknown, paths: readonly string[], fn: (v: unknown) => unknown) {
  if (!obj || typeof obj !== 'object') return;
  for (const p of paths) walk(obj as Record<string, unknown>, p.split('.'), fn);
}
function walk(o: Record<string, unknown> | null | undefined, parts: string[], fn: (v: unknown) => unknown) {
  if (!o || typeof o !== 'object') return;
  const [head, ...rest] = parts;
  const list = head.endsWith('[]');
  const key = list ? head.slice(0, -2) : head;
  if (!(key in o)) return;
  if (list) {
    const arr = o[key];
    if (Array.isArray(arr)) for (const item of arr) if (rest.length) walk(item as Record<string, unknown>, rest, fn);
    return;
  }
  if (!rest.length) { o[key] = fn(o[key]); return; }
  walk(o[key] as Record<string, unknown>, rest, fn);
}

const clone = <T>(v: T): T => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
const rootOf = (p: string) => p.split('.')[0].replace('[]', '');
const UPDATE_OPS = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'] as const;
const READ_OPS = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace'] as const;

/** Cifra o que for gravado nesses caminhos e decifra ao ler (documentos, lean e agregações). */
export function encryptedFields(paths: readonly string[], opts: { phoneIndex?: { from: string; to: string } } = {}) {
  const roots = [...new Set(paths.map(rootOf))];
  return (schema: Schema) => {
    // Gravação de documento (create/save): cifra; depois, devolve em claro na memória (a resposta não leva a cifra).
    schema.pre('save', function (this: { get(p: string): unknown; set(p: string, v: unknown): void }) {
      if (opts.phoneIndex) this.set(opts.phoneIndex.to, phoneIndex(decrypt(this.get(opts.phoneIndex.from)) as string));
      for (const r of roots) {
        const v = this.get(r);
        if (v === undefined || v === null) continue;
        const holder = { [r]: clone(v) };
        mapPaths(holder, paths.filter((p) => rootOf(p) === r), encrypt);
        if (JSON.stringify(holder[r]) !== JSON.stringify(v)) this.set(r, holder[r]);
      }
    });
    const plainInMemory = function (this: { _doc?: Record<string, unknown> }) { if (this?._doc) mapPaths(this._doc, paths, decrypt); };
    schema.post('save', plainInMemory);
    schema.post('init', plainInMemory);

    // Atualizações ($set, $setOnInsert, $push e substituição): cifra os caminhos protegidos.
    for (const op of UPDATE_OPS) {
      schema.pre(op, function (this: { getUpdate(): Record<string, unknown> | null }) {
        const u = this.getUpdate(); if (!u) return;
        encryptUpdate(u, paths, opts.phoneIndex);
        for (const k of ['$set', '$setOnInsert', '$push', '$addToSet'] as const) if (u[k] && typeof u[k] === 'object') encryptUpdate(u[k] as Record<string, unknown>, paths, opts.phoneIndex);
      });
    }
    schema.pre('insertMany', function (_next: unknown, docs: unknown) {
      for (const d of [].concat(docs as never)) mapPaths(d, paths, encrypt);
    });

    // Leituras "lean" (objetos comuns) e agregações: decifra no resultado.
    for (const op of READ_OPS) {
      schema.post(op, function (this: { mongooseOptions?(): { lean?: unknown } }, res: unknown) {
        if (!this.mongooseOptions?.().lean) return; // documento completo já foi decifrado no 'init'
        for (const d of Array.isArray(res) ? res : [res]) mapPaths(d, paths, decrypt);
      });
    }
    (schema as unknown as { post(op: 'aggregate', fn: (res: unknown[]) => void): void }).post('aggregate', (res) => {
      for (const d of res ?? []) mapPaths(d, paths, decrypt);
    });
  };
}

/** Numa atualização, cifra as chaves que são (ou contêm) um caminho protegido. */
export function encryptUpdate(u: Record<string, unknown>, paths: readonly string[], idx?: { from: string; to: string }) {
  for (const key of Object.keys(u)) {
    if (key.startsWith('$')) continue;
    const plainKey = key.replace(/\.\$(\[\w*\])?/g, '[]').replace(/\.\d+/g, '[]'); // addresses.0.street → addresses[].street
    for (const p of paths) {
      if (p === plainKey || p.replace(/\[\]/g, '') === key) { u[key] = encrypt(u[key]); continue; }
      const prefix = plainKey.endsWith('[]') ? plainKey : `${plainKey}.`;
      const norm = p.replace(/\[\]/g, '');
      if (p.startsWith(prefix) || norm.startsWith(`${key}.`)) {
        // A chave é um objeto/lista que contém o caminho (ex.: { customer: {...} } ou { addresses: [...] }).
        const rel = p.startsWith(prefix) ? p.slice(prefix.length) : norm.slice(key.length + 1);
        const holder = { v: u[key] };
        mapPaths(holder, [`v${Array.isArray(u[key]) ? '[]' : ''}.${rel}`], encrypt);
        u[key] = holder.v;
      }
    }
    if (idx && key === idx.from) {
      const plain = decrypt(u[key]);
      if (typeof plain === 'string') u[idx.to] = phoneIndex(plain); // ex.: { 'customer.phone': ... } → 'customer.phoneIdx'
    } else if (idx && key === idx.from.split('.')[0] && u[key] && typeof u[key] === 'object') {
      // Objeto inteiro (ex.: { customer: {...} }): o índice vai dentro dele, para não conflitar na mesma atualização.
      const obj = u[key] as Record<string, unknown>; const leaf = idx.from.split('.').slice(1).join('.'); const to = idx.to.split('.').slice(1).join('.');
      const plain = decrypt(obj[leaf]);
      if (typeof plain === 'string') obj[to] = phoneIndex(plain);
    }
  }
}
