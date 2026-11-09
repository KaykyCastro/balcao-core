// Criptografa os dados pessoais que ainda estão em claro no banco (telefone, CPF/CNPJ e endereço de compradores,
// clientes e pedidos) e cria o índice de busca do telefone dos pedidos. Pode rodar mais de uma vez: só mexe no que
// ainda não tem o prefixo "enc:v1:". FAÇA BACKUP ANTES (mongodump) e use a MESMA SECRETS_KEY da API.
// Uso (com MONGO_URI e SECRETS_KEY no .env):
//   npm run encrypt:pii            criptografa
//   npm run encrypt:pii -- --dry   só conta o que seria criptografado
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { encrypt, isEncrypted, phoneIndex } = require('../dist/common/security/field-crypto');

const ADDR = ['cep', 'street', 'number', 'complement', 'district'];
const JOBS = [
  { coll: 'shoppers', fields: ['phone', 'document'], lists: { addresses: ADDR } },
  { coll: 'customerschemas', fields: ['address', 'numberWithPrefix'] },
  { coll: 'orders', fields: ['customer.phone', 'customer.document', ...ADDR.map((f) => `address.${f}`)], phoneIdx: true },
];
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const plain = (v) => typeof v === 'string' && v !== '' && !isEncrypted(v);

(async () => {
  if (!process.env.SECRETS_KEY && process.env.NODE_ENV === 'production') throw new Error('Defina SECRETS_KEY (a mesma da API) antes de criptografar.');
  const dry = process.argv.includes('--dry');
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGO_DB);
  const db = mongoose.connection.db;
  for (const job of JOBS) {
    let docs = 0, values = 0; const ops = [];
    const flush = async () => { if (ops.length && !dry) await db.collection(job.coll).bulkWrite(ops.splice(0), { ordered: false }); else ops.length = 0; };
    for await (const d of db.collection(job.coll).find({})) {
      const set = {};
      for (const f of job.fields) { const v = get(d, f); if (plain(v)) { set[f] = encrypt(v); values++; } }
      for (const [list, subs] of Object.entries(job.lists ?? {})) {
        const arr = d[list];
        if (Array.isArray(arr) && arr.some((a) => subs.some((s) => plain(a?.[s])))) {
          set[list] = arr.map((a) => { const n = { ...a }; for (const s of subs) if (plain(n[s])) { n[s] = encrypt(n[s]); values++; } return n; });
        }
      }
      if (job.phoneIdx) { const p = get(d, 'customer.phone'); const idx = phoneIndex(plain(p) ? p : null); if (idx && get(d, 'customer.phoneIdx') !== idx) set['customer.phoneIdx'] = idx; }
      if (Object.keys(set).length) { docs++; ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: set } } }); }
      if (ops.length >= 500) await flush();
    }
    await flush();
    console.log(`${job.coll}: ${docs} registro(s), ${values} valor(es) ${dry ? 'a criptografar' : 'criptografados'}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
