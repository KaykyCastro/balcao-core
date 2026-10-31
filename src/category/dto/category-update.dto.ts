import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CategoryUpdateDto {

    @IsNotEmpty()
    @IsString() @MaxLength(80)
    name: string;

}