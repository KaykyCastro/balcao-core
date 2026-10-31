import { Prop, Schema } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { HydratedDocument } from 'mongoose';
import { SchemaFactory } from '@nestjs/mongoose';

export type DebitItemDocument = HydratedDocument<DebitItemSchema>;

@Schema({ timestamps: true })
export class DebitItemSchema {

    @Prop({required: true})
    productName: string;

    @Prop({ required: true })
    productCode: string;

    @Prop({ required: true, min: 0 })
    unitPrice: number;

    @Prop({ required: true, min: 1 })
    quantity: number;

    @Prop({ required: true, min: 0 })
    total: number;

    @Prop({ type: Types.ObjectId , ref: 'Product', required: true, index: true })
    productId: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Debit', required: true, index: true })
    debitId: Types.ObjectId;
    
}

export const DebitItemSchemaFactory = SchemaFactory.createForClass(DebitItemSchema);