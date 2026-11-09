import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Shift, ShiftSchemaFactory, Staff, StaffAccessLog, StaffAccessLogSchema, StaffSchemaFactory } from './schema/staff.schema';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { EnterpriseSchemaFactory } from '../enterprise/schema/enterprise.schema';
import { Sale, SaleSchemaFactory } from '../sale/schema/sale.schema';

@Module({
  imports: [MongooseModule.forFeature([
    { name: Staff.name, schema: StaffSchemaFactory },
    { name: Shift.name, schema: ShiftSchemaFactory },
    { name: StaffAccessLog.name, schema: StaffAccessLogSchema },
    { name: 'EnterpriseSchema', schema: EnterpriseSchemaFactory },
    { name: Sale.name, schema: SaleSchemaFactory },
  ])],
  controllers: [StaffController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}
