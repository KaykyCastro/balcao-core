import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { EnterpriseSchema, EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';
import { AuditLog, AuditLogSchemaFactory } from '../admin/audit.schema';
import { MessagesModule } from '../messages/messages.module';
import { DesignAccess, DesignAccessSchemaFactory } from './design-access.schema';
import { AdminDesignController, StoreDesignController } from './design.controller';
import { DesignService } from './design.service';
import { DesignSessionGuard } from './design.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DesignAccess.name, schema: DesignAccessSchemaFactory },
      { name: EnterpriseSchema.name, schema: EnterpriseSchemaFactory },
      { name: AuditLog.name, schema: AuditLogSchemaFactory },
    ]),
    MessagesModule,
    // Mesmo segredo da sessão: o token é validado pela JwtStrategy, que confere o `ds` a cada pedido.
    JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET'), signOptions: { algorithm: 'HS256' } }) }),
  ],
  controllers: [AdminDesignController, StoreDesignController],
  providers: [DesignService, DesignSessionGuard],
  exports: [DesignService, DesignSessionGuard],
})
export class DesignModule {}
