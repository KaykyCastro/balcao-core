import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { STAFF_PERMS, STAFF_ROLES, TIME_RE } from '../staff.rules';

const USER_RE = /^[a-z0-9._-]{3,30}$/;

export class ScheduleWindowDto {
  @IsInt() @Min(0) @Max(6) day: number;
  @Matches(TIME_RE, { message: 'Horário no formato 08:00' }) start: string;
  @Matches(TIME_RE, { message: 'Horário no formato 08:00' }) end: string;
}
export class ScheduleDto {
  @IsBoolean() enabled: boolean;
  @IsArray() @ArrayMaxSize(28) @ValidateNested({ each: true }) @Type(() => ScheduleWindowDto) windows: ScheduleWindowDto[];
}
export class StaffCreateDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsIn(STAFF_ROLES as unknown as string[]) role: 'cashier' | 'waiter';
  @Matches(USER_RE, { message: 'Usuário: 3 a 30 letras minúsculas, números, ponto, hífen ou _' }) username: string;
  @IsString() @MinLength(6, { message: 'Senha com pelo menos 6 caracteres' }) @MaxLength(72) password: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(STAFF_PERMS as unknown as string[], { each: true }) permissions?: string[];
  @IsOptional() @ValidateNested() @Type(() => ScheduleDto) schedule?: ScheduleDto;
}
export class StaffUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsIn(STAFF_ROLES as unknown as string[]) role?: 'cashier' | 'waiter';
  @IsOptional() @Matches(USER_RE, { message: 'Usuário: 3 a 30 letras minúsculas, números, ponto, hífen ou _' }) username?: string;
  @IsOptional() @IsString() @MinLength(6, { message: 'Senha com pelo menos 6 caracteres' }) @MaxLength(72) password?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(STAFF_PERMS as unknown as string[], { each: true }) permissions?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateNested() @Type(() => ScheduleDto) schedule?: ScheduleDto;
}
export class StaffLoginDto {
  @IsString() @MaxLength(20) code: string;
  @IsString() @MaxLength(30) username: string;
  @IsString() @MaxLength(72) password: string;
}
export class ShiftStartDto {
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsInt({ each: true }) @Min(1, { each: true }) @Max(300, { each: true }) tables?: number[];
}
export class ShiftsQueryDto {
  @IsOptional() @IsMongoId() staffId?: string;
}
export class MetricsQueryDto {
  @IsOptional() @Type(() => Number) @IsIn([1, 7, 30, 90]) days?: number;
}
export class AccessLogQueryDto {
  @IsOptional() @IsMongoId() staffId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) page?: number;
}
