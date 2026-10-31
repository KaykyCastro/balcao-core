import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CategoryCreateDto {
  @IsNotEmpty()
  @IsString() @MaxLength(80)
  name: string;
}
