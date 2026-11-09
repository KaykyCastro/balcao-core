import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { raw } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const prod = process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  // Atrás de proxy/balanceador (nginx, Render, Railway...), o IP real vem do X-Forwarded-For: sem isso o rate limit enxerga um IP só.
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  // Em produção quase sempre há um proxy na frente: sem TRUST_PROXY, todos os clientes parecem vir do mesmo IP e o
  // limite de tentativas de login (por IP) passa a valer para todo mundo junto.
  else if (prod) new Logger('Segurança').warn('TRUST_PROXY não definido: se a API estiver atrás de um proxy (nginx, Render, Railway, Cloudflare), o limite de tentativas por IP vai tratar todos os clientes como um só. Defina TRUST_PROXY=1 (ou o número de proxies).');

  app.use(helmet());
  // Fotos, logos, banners e vídeos vão direto para o Cloudflare R2 por URL assinada (storage/): o JSON só leva
  // endereços, então /product e /store-config usam o limite geral (antes 4 MB e 6 MB, com imagens em base64).
  // Em desenvolvimento sem R2, o PUT assinado chega aqui como bytes crus.
  app.use('/storage/local', raw({ type: () => true, limit: '41mb' }));
  // Corpo pequeno por padrão. Ainda cabe uma imagem base64 de cliente antigo (a API sobe para o R2 sozinha).
  app.useBodyParser('json', { limit: '600kb' });
  app.useBodyParser('urlencoded', { limit: '50kb', extended: false });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,              // descarta campos desconhecidos
    forbidNonWhitelisted: true,   // ...e recusa a requisição (400) em vez de ignorar em silêncio
    transform: true,
    stopAtFirstError: true,
    validationError: { target: false, value: false }, // não devolve o valor enviado (ex.: senha) na resposta de erro
  }));

  // CORS_ORIGIN: lista separada por vírgula. Em produção é obrigatório (validado na subida).
  const origins = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins?.length ? origins : !prod, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Design-Session', 'Idempotency-Key', 'X-Requested-With'], maxAge: 600 });

  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 2700);
  await app.listen(port);
  new Logger('Bootstrap').log(`API na porta ${port} (${prod ? 'produção' : 'desenvolvimento'})`);
}
bootstrap();
