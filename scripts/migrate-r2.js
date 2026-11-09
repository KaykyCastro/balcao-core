// Sobe para o Cloudflare R2 as imagens em base64 e os vídeos do GridFS e troca pelos endereços novos.
// Pode rodar mais de uma vez: só mexe no que ainda não foi migrado. FAÇA BACKUP ANTES (mongodump).
// Uso (com as variáveis R2_* e MONGO_URI no .env):
//   npm run migrate:r2                 migra
//   npm run migrate:r2 -- --dry        só conta o que seria migrado
//   npm run migrate:r2 -- --delete-gridfs   migra e apaga do GridFS os vídeos já copiados
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { MigrationModule, migrateToR2 } = require('../dist/storage/migrate-r2');

(async () => {
  const args = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(MigrationModule, { logger: ['log', 'warn', 'error'] });
  try {
    const rep = await migrateToR2(app, { dry: args.includes('--dry'), deleteGridfs: args.includes('--delete-gridfs') });
    for (const f of rep.failures) console.warn(' - falhou:', f);
    process.exitCode = rep.failures.length ? 1 : 0;
  } finally {
    await app.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
