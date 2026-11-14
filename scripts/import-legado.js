// Importa para uma loja do Balcão os dados convertidos de um sistema antigo (veja scripts/legado-converter.py).
// Não usa senha de ninguém: acha a loja pelo e-mail da conta. FAÇA BACKUP ANTES (mongodump).
// Uso (no servidor, com MONGO_URI e SECRETS_KEY no .env):
//   npm run import:legado -- --arquivo /caminho/dados.json --email loja@exemplo.com            SIMULA (não grava nada)
//   npm run import:legado -- --arquivo /caminho/dados.json --email loja@exemplo.com --gravar   grava
// Pode rodar de novo: o que já foi importado é pulado.
require('reflect-metadata');
const fs = require('fs');
const { NestFactory } = require('@nestjs/core');
const { LegacyImportModule, importLegacy } = require('../dist/legacy/import-legado');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

(async () => {
  const arquivo = arg('--arquivo'), email = arg('--email'), dry = !process.argv.includes('--gravar');
  if (!arquivo || !email) { console.error('Uso: npm run import:legado -- --arquivo dados.json --email loja@exemplo.com [--gravar]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const app = await NestFactory.createApplicationContext(LegacyImportModule, { logger: ['log', 'warn', 'error'] });
  try {
    const rep = await importLegacy(app, data, { email, dry });
    console.log(`\n${dry ? 'SIMULAÇÃO (nada foi gravado; rode com --gravar)' : 'IMPORTAÇÃO CONCLUÍDA'} · ${rep.loja}`);
    console.log('Criados:', rep.criados);
    console.log('Já existiam (pulados):', rep.jaExistiam);
    if (rep.avisos.length) { console.log(`Avisos (${rep.avisos.length}):`); for (const a of rep.avisos.slice(0, 50)) console.log(' -', a); }
  } finally {
    await app.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
