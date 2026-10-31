import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MSG } from '../../enterprise/dto/enterprise-create.dto';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class ForgotPasswordDto {
  @Transform(lower) @IsEmail() @MaxLength(254)
  email: string;
}
export class ResetPasswordDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/, { message: 'Link inválido ou expirado' })
  token: string;

  @IsString() @MinLength(8, { message: PASSWORD_MSG }) @MaxLength(72, { message: PASSWORD_MSG })
  password: string;
}
export class ChangePasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(72)
  currentPassword: string;

  @IsString() @MinLength(8, { message: PASSWORD_MSG }) @MaxLength(72, { message: PASSWORD_MSG })
  newPassword: string;
}
