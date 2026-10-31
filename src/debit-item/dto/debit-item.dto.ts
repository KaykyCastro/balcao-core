import {Types} from 'mongoose';

export class DebitItemDto {
    _id: Types.ObjectId;
    productName: string;
    productCode: string;
    unitPrice: number;
    quantity: number;
    total: number;
    productId: Types.ObjectId;
    debitId: Types.ObjectId;
}