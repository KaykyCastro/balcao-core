
import { IsNotEmpty, IsNumber, IsMongoId, IsOptional, IsString } from 'class-validator';
import { Types } from 'mongoose';

export class DebitItemCreateDto {

    @IsNotEmpty()
    @IsString()
    productName: string;

    @IsNotEmpty()
    @IsString()
    productCode: string;

    @IsNotEmpty()
    @IsNumber()
    unitPrice: number;

    @IsNotEmpty()
    @IsNumber()
    quantity: number;

    @IsNotEmpty()
    @IsNumber()
    total: number;

    @IsNotEmpty()
    @IsMongoId()
    productId: Types.ObjectId;

    @IsNotEmpty()
    @IsMongoId()
    debitId: Types.ObjectId;

}