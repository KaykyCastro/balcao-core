import { IsMongoId, IsInt, Min } from 'class-validator';

export class DebitItemInputDto {
  @IsMongoId()
  productId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}