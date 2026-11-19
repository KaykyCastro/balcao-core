import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { CategorySchema, CategorySchemaFactory } from '../category/schema/category.schema';
import { EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';
import { ProductSchema, ProductSchemaFactory } from '../products/schema/product.schema';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';
import { Staff, StaffSchemaFactory } from '../staff/schema/staff.schema';
import { BranchController } from './branch.controller';
import { BranchService } from './branch.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'EnterpriseSchema', schema: EnterpriseSchemaFactory },
      { name: ProductSchema.name, schema: ProductSchemaFactory },
      { name: CategorySchema.name, schema: CategorySchemaFactory },
      { name: Sale.name, schema: SaleSchemaFactory },
      { name: Staff.name, schema: StaffSchemaFactory },
    ]),
    // Mesmo segredo da sessão: a troca de loja emite a sessão da loja escolhida.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET'), signOptions: { algorithm: 'HS256' } }),
    }),
  ],
  controllers: [BranchController],
  providers: [BranchService],
})
export class BranchModule {}
