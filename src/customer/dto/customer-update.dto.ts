import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CustomerUpdateDto {
  @IsOptional() @IsNotEmpty() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(300)
  address?: string;

  @IsOptional() @IsString() @MaxLength(20) @Matches(/^[0-9+() -]*$/, { message: 'Telefone inválido' })
  numberWithPrefix?: string;
}
