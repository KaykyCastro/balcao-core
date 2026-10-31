import { Types } from 'mongoose';

export class DebitDto {
    _id: Types.ObjectId;
    total: number;
    customerId: string;
    debitItemsId: Types.ObjectId[];
}