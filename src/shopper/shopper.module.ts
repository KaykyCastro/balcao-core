import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Shopper, ShopperSchemaFactory } from './schema/shopper.schema';
import { ShopperService } from './shopper.service';
import { ShopperController } from './shopper.controller';
import { ShopperGuard } from './shopper.guard';
import { CustomerModule } from '../customer/customer.module';
import { LegalModule } from '../legal/legal.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Shopper.name, schema: ShopperSchemaFactory }]),
    // Segredo derivado e separado do JWT do lojista: um token nunca é aceito no lugar do outro.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: `${config.getOrThrow<string>('JWT_SECRET')}::shopper` }),
    }),
    CustomerModule,
    LegalModule,
  ],
  controllers: [ShopperController],
  providers: [ShopperService, ShopperGuard],
  exports: [ShopperService, ShopperGuard],
})
export class ShopperModule {}
