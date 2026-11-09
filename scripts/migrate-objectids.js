// Converte ids gravados como TEXTO para ObjectId. Idempotente (pode rodar mais de uma vez).
// FAÇA BACKUP ANTES (mongodump). Uso:
//   mongosh "SUA_MONGO_URI" --file scripts/migrate-objectids.js
// Para só conferir, sem alterar:  DRY=1 mongosh "SUA_MONGO_URI" --file scripts/migrate-objectids.js
const dry = typeof process !== 'undefined' && process.env && process.env.DRY === '1';
const plan = [
  ['auditlogs', ['actorId', 'targetEnterpriseId'], []],
  ['feeentries', ['enterpriseId', 'saleId', 'invoiceId'], []],
  ['invoices', ['enterpriseId'], []],
  ['paymentevents', ['invoiceId'], []],
  ['categoryschemas', ['enterpriseId'], []],
  ['customerpayments', ['enterpriseId', 'customerId'], []],
  ['customerschemas', ['enterpriseId'], []],
  ['messages', ['enterpriseId', 'broadcastId'], []],
  ['productschemas', ['enterpriseId', 'categoryId'], []],
  ['sales', ['enterpriseId', 'customerId'], [['items', 'productId']]],
];
const isHex = (f) => ({ $regexMatch: { input: { $toString: `$${f}` }, regex: /^[a-f0-9]{24}$/i } });
for (const [coll, fields, arrays] of plan) {
  const c = db.getCollection(coll);
  if (!db.getCollectionNames().includes(coll)) { print(`- ${coll}: não existe, pulando`); continue; }
  for (const f of fields) {
    const filter = { [f]: { $type: 'string', $regex: /^[a-f0-9]{24}$/i } };
    const n = c.countDocuments(filter);
    if (n && !dry) c.updateMany(filter, [{ $set: { [f]: { $toObjectId: `$${f}` } } }]);
    print(`${dry ? '[simulação] ' : ''}${coll}.${f}: ${n} documento(s) ${dry ? 'seriam convertidos' : 'convertidos'}`);
  }
  for (const [arr, f] of arrays) {
    const filter = { [arr]: { $elemMatch: { [f]: { $type: 'string', $regex: /^[a-f0-9]{24}$/i } } } };
    const n = c.countDocuments(filter);
    if (n && !dry) {
      c.updateMany(filter, [{ $set: { [arr]: { $map: { input: `$${arr}`, as: 'it', in: { $mergeObjects: ['$$it', { [f]: { $cond: [{ $eq: [{ $type: `$$it.${f}` }, 'string'] }, { $toObjectId: `$$it.${f}` }, `$$it.${f}`] } }] } } } } }]);
    }
    print(`${dry ? '[simulação] ' : ''}${coll}.${arr}.${f}: ${n} documento(s)`);
  }
}
print('Pronto.');
