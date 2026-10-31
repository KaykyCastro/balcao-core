import { Body, Controller, Delete, INestApplication, Param, Post, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_FILTER, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule, Throttle } from '@nestjs/throttler';
import request from 'supertest';
import { LoginDto } from './auth/dto/login.dto';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ParseMongoIdPipe } from './common/pipes/parse-mongo-id.pipe';
import { RolesGuard } from './common/guards/roles.guard';
import { Roles } from './common/decorators/roles.decorator';
import { validateEnv } from './common/config/env';

@Controller()
class T {
  @Post('login') login(@Body() b: LoginDto) { return { ok: !!b.email }; }
  @Post('limited') @Throttle({ default: { limit: 3, ttl: 60_000 } }) limited() { return 1; }
  @Delete('x/:id') del(@Param('id', ParseMongoIdPipe) id: string) { return { id }; }
  @Post('boom') boom() { throw new Error('senha=123 stack secreta'); }
  @Post('admin') @Roles('admin') admin() { return 1; }
}

describe('camada HTTP', () => {
  let app: INestApplication;
  let user: any;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [T],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useFactory: (r: Reflector) => ({ canActivate: (c: any) => { c.switchToHttp().getRequest().user = user; return true; } }), inject: [Reflector] },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: true, validationError: { target: false, value: false } }));
    await app.init();
  });
  afterAll(() => app.close());

  it('campo desconhecido → 400; e-mail em formato de objeto (NoSQL injection) → 400', async () => {
    await request(app.getHttpServer()).post('/login').send({ email: 'a@b.com', password: 'x', role: 'admin' }).expect(400);
    await request(app.getHttpServer()).post('/login').send({ email: { $ne: null }, password: 'x' }).expect(400);
    await request(app.getHttpServer()).post('/login').send({ email: 'a@b.com', password: { $gt: '' } }).expect(400);
  });
  it('erro de validação não devolve a senha enviada', async () => {
    const r = await request(app.getHttpServer()).post('/login').send({ email: 'ruim', password: 'MinhaSenha!123' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('MinhaSenha');
  });
  it('rate limit por rota → 429 depois do limite', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app.getHttpServer()).post('/limited')).status);
    expect(codes.slice(-1)[0]).toBe(429);
  });
  it('id inválido → 400, não 500', async () => {
    await request(app.getHttpServer()).delete('/x/abc').expect(400);
    await request(app.getHttpServer()).delete('/x/' + 'a'.repeat(24)).expect(200);
  });
  it('erro interno não vaza mensagem nem stack', async () => {
    const r = await request(app.getHttpServer()).post('/boom');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/senha|stack|Error:/i);
  });
  it('rota de admin: usuário comum 403, anônimo 403, admin 201', async () => {
    user = { role: 'user' };
    await request(app.getHttpServer()).post('/admin').expect(403);
    user = undefined;
    await request(app.getHttpServer()).post('/admin').expect(403);
    user = { role: 'admin' };
    await request(app.getHttpServer()).post('/admin').expect(201);
  });
});

describe('validateEnv', () => {
  const good = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), MONGO_URI: 'mongodb://h/db', CORS_ORIGIN: 'https://app.x.com', APP_URL: 'https://api.x.com', FRONTEND_URL: 'https://app.x.com', INFINITEPAY_HANDLE: 'tag', INFINITEPAY_WEBHOOK_SECRET: 'y'.repeat(32) } as NodeJS.ProcessEnv;
  it('aceita config de produção completa', () => expect(() => validateEnv(good)).not.toThrow());
  it.each([
    ['JWT_SECRET', { JWT_SECRET: 'curto' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: '' }],
    ['APP_URL', { APP_URL: 'http://api.x.com' }],
    ['INFINITEPAY_HANDLE', { INFINITEPAY_HANDLE: '' }],
    ['INFINITEPAY_WEBHOOK_SECRET', { INFINITEPAY_WEBHOOK_SECRET: 'curto' }],
  ])('recusa produção sem %s válido', (name, patch) => expect(() => validateEnv({ ...good, ...patch })).toThrow(new RegExp(name)));
  it('em desenvolvimento só exige JWT_SECRET e Mongo', () => expect(() => validateEnv({ JWT_SECRET: 'dev', MONGO_URI: 'm' } as any)).not.toThrow());
});
