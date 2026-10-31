import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const prod = process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  // Atrás de proxy/balanceador (nginx, Render, Railway...), o IP real vem do X-Forwarded-For: sem isso o rate limit enxerga um IP só.
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);

  app.use(helmet());
  // Corpo pequeno por padrão (a logo em base64 é o maior campo e tem teto de 400 KB nos DTOs).
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
  app.enableCors({ origin: origins?.length ? origins : !prod, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Requested-With'], maxAge: 600 });

  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 2700);
  await app.listen(port);
  new Logger('Bootstrap').log(`API na porta ${port} (${prod ? 'produção' : 'desenvolvimento'})`);
}
bootstrap();
