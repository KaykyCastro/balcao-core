import { StorageModule } from './storage/storage.module';
import { StaffModule } from './staff/staff.module';
import { StaffGuard } from './staff/staff.guard';
import { DesignSessionGuard } from './design/design.guard';
import { DesignModule } from './design/design.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LegalModule } from './legal/legal.module';
import { AccessLogInterceptor } from './legal/access-log.interceptor';
import type { Connection } from 'mongoose';
import { tenantGuard } from './common/security/tenant-guard.plugin';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { BillingGuard } from './common/guards/billing.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { CsrfGuard } from './common/guards/csrf.guard';
import { SettingsModule } from './settings/settings.module';
import { MessagesModule } from './messages/messages.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { validateEnv } from './common/config/env';

import { EnterprisesModule } from './enterprise/enterprise.module';
import { ProductModule } from './products/product.module';
import { CategorysModule } from './category/category.module';
import { CustomerModule } from './customer/customer.module';
import { AuthModule } from './auth/auth.module';
import { SaleModule } from './sale/sale.module';
import { BillingModule } from './billing/billing.module';
import { AdminModule } from './admin/admin.module';
import { ReportModule } from './report/report.module';
import { PromotionModule } from './promotion/promotion.module';
import { MailModule } from './mail/mail.module';
import { ShopperModule } from './shopper/shopper.module';
import { PosModule } from './pos/pos.module';
import { StoreModule } from './store/store.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    DesignModule,
    ConfigModule.forRoot({ isGlobal: true, validate: (env) => { validateEnv(env as NodeJS.ProcessEnv); return env; } }),
    ScheduleModule.forRoot(),
    StorageModule,
    // Limite geral por IP; rotas sensíveis (login, cadastro, recuperação) têm limites próprios com @Throttle.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>('MONGO_URI') ?? config.get<string>('MONGO_DB');
        if (!uri) throw new Error('Defina MONGO_URI (ex.: mongodb://host:27017/db?replicaSet=rs0)');
        return {
          uri, autoIndex: config.get('NODE_ENV') !== 'production' || config.get('MONGO_AUTO_INDEX') === 'true',
          // Isolamento entre lojas: toda consulta em coleção com enterpriseId precisa dizer de qual loja é (TENANT_GUARD).
          connectionFactory: (conn: Connection) => { conn.plugin(tenantGuard); return conn; },
        };
      },
    }),
    MailModule,
    SettingsModule,
    EnterprisesModule,
    ProductModule,
    CategorysModule,
    CustomerModule,
    AuthModule,
    SaleModule,
    BillingModule,
    ReportModule,
    PromotionModule,
    MessagesModule,
    ShopperModule,
    StoreModule, PosModule, StaffModule, LegalModule,
    AdminModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // A ordem importa: limite de requisições, CSRF, autenticação (JWT), bloqueio por fatura vencida, papéis.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: StaffGuard }, // funcionário: só o que a permissão libera, com turno aberto
    { provide: APP_GUARD, useClass: DesignSessionGuard }, // sessão de design do admin: só o site da loja
    { provide: APP_GUARD, useClass: BillingGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor }, // Marco Civil, art. 15: registro de acesso
  ],
})
export class AppModule {}
