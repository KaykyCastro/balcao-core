import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SendMessageDto {
  /** Sem `enterpriseId`, vai para todas as empresas ativas. */
  @IsOptional() @IsMongoId()
  enterpriseId?: string;

  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120)
  title: string;

  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(2000)
  body: string;

  @IsOptional() @IsIn(['info', 'warning'])
  level?: 'info' | 'warning';
}

export class InboxQuery extends PaginationQueryDto {
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean()
  unread?: boolean;
}

export class SentQuery extends PaginationQueryDto {
  @IsOptional() @IsMongoId()
  enterpriseId?: string;
}
