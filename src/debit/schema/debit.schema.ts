import { Prop, Schema } from '@nestjs/mongoose';
import {Types} from 'mongoose';
import { SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DebitDocument = HydratedDocument<DebitSchema>;

@Schema({ timestamps: true })
export class DebitSchema {

    @Prop({ required: true })
    value: number;

    @Prop({ required: true })
    customerId: Types.ObjectId;

    @Prop({ required: true, default: [] })
    debitItemsId: Types.ObjectId[];

}

export const DebitSchemaFactory = SchemaFactory.createForClass(DebitSchema);