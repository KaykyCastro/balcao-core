import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { setSessionCookie } from '../auth/session-cookie';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { BranchService } from './branch.service';

class CreateBranchDto {
  @IsString() @MaxLength(60) name: string;
  @IsOptional() @IsString() @MaxLength(20) cnpj?: string;
}
class RenameBranchDto {
  @IsString() @MaxLength(60) name: string;
}
class SearchDto {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) page?: number;
}
class ImportDto {
  @IsMongoId() from: string;
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsMongoId({ each: true }) productIds?: string[];
  @IsOptional() @IsBoolean() all?: boolean;
  @IsOptional() @IsBoolean() withStock?: boolean;
}

/**
 * Filiais do grupo da empresa logada (matriz + filiais). Só o dono (colaboradores não têm regra em staff.rules.ts,
 * exceto a busca de produto entre lojas). A troca de loja põe a sessão da loja escolhida no cookie.
 */
@Controller('branches')
export class BranchController {
  constructor(private readonly svc: BranchService, private readonly config: ConfigService) {}

  @Get()
  list(@CurrentEnterprise() eid: string) { return this.svc.list(eid); }

  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post()
  create(@CurrentEnterprise() eid: string, @Body() dto: CreateBranchDto) { return this.svc.create(eid, dto); }

  @Patch(':id')
  rename(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: RenameBranchDto) { return this.svc.rename(eid, id, dto.name); }

  /** Entra em outra loja do grupo (sessão do site). */
  @Post(':id/switch') @HttpCode(200)
  async switch(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const s = await this.svc.switchTo(eid, id);
    setSessionCookie(res, this.config, s.accessToken, s.expiresAt);
    return { store: s.store };
  }

  /** Busca um produto em todas as lojas do grupo (preço e estoque de cada uma). */
  @Get('products')
  search(@CurrentEnterprise() eid: string, @Query() q: SearchDto) { return this.svc.searchProducts(eid, q.q ?? ''); }

  /** Produtos de outra loja do grupo, para escolher o que importar para esta. */
  @Get(':id/products')
  source(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Query() q: SearchDto) { return this.svc.sourceProducts(eid, id, q.q ?? '', q.page ?? 1); }

  /** Importa produtos de outra loja do grupo para a loja em que você está. */
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @Post('import') @HttpCode(200)
  import(@CurrentEnterprise() eid: string, @Body() dto: ImportDto) { return this.svc.importProducts(eid, dto); }
}
