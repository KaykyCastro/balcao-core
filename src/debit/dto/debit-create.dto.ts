import { IsArray, ArrayNotEmpty, IsMongoId, ValidateNested } from 'class-validator';
import { DebitItemInputDto } from './debit-item-input.dto';
import { Type } from 'class-transformer';

export class DebitCreateDto {

  @IsMongoId()
  enterpriseId: string;

  @IsMongoId()
  customerId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => DebitItemInputDto)
  items: DebitItemInputDto[];
}