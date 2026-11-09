import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail() @MaxLength(254)
  email: string;

  @IsString() @IsNotEmpty() @MaxLength(72)
  password: string;

  /** App: token de "aparelho confiável" guardado no aparelho (o site usa um cookie httpOnly). */
  @IsOptional() @IsString() @MaxLength(2000)
  deviceToken?: string;
}
