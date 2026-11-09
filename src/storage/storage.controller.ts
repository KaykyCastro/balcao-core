import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Req, Res } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { Public } from '../common/decorators/public.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { LocalDriver } from './storage.driver';
import { UPLOAD_KINDS, type UploadKind } from './storage.rules';
import { StorageService } from './storage.service';

class PresignDto {
  @IsIn(UPLOAD_KINDS) kind: UploadKind;
  @IsString() @MaxLength(60) contentType: string;
  @IsInt() @Min(1) size: number;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}

type Principal = { role?: string; staff?: unknown };

/**
 * Envio de arquivos em 2 passos: `presign` devolve uma URL curta para mandar o arquivo direto ao R2;
 * `complete` confere o arquivo que chegou. Depois o cliente salva a URL no produto/loja.
 */
@Controller('uploads')
export class UploadController {
  constructor(private readonly storage: StorageService) {}

  /** Dono do arquivo: a empresa logada; banners do marketplace são da plataforma (só admin). */
  private owner(req: Request, eid: string, kind: UploadKind) {
    const u = req.user as Principal | undefined;
    if (kind === 'banner') { if (u?.role !== 'admin') throw new ForbiddenException('Acesso negado'); return null; }
    if (u?.staff && kind !== 'product') throw new ForbiddenException('Colaboradores só enviam fotos de produto');
    return eid;
  }

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('presign') @HttpCode(200)
  presign(@Req() req: Request, @CurrentEnterprise() eid: string, @Body() dto: PresignDto) {
    return this.storage.presign(this.owner(req, eid, dto.kind), dto.kind, dto.contentType, dto.size, dto.name);
  }

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post(':id/complete') @HttpCode(200)
  complete(@Req() req: Request, @CurrentEnterprise() eid: string, @Param('id') id: string) {
    const admin = (req.user as Principal | undefined)?.role === 'admin';
    // Envio da empresa logada, ou da plataforma (banner do marketplace) quando quem pede é admin.
    return this.storage.complete(id, (owner) => owner === String(eid) || (owner === null && admin));
  }
}

/** Só em desenvolvimento sem R2: recebe o PUT assinado e serve os arquivos da pasta local. */
@Public()
@AllowWhenBlocked()
@SkipThrottle()
@Controller('storage')
export class LocalStorageController {
  constructor(private readonly storage: StorageService) {}
  private get local() {
    const d = this.storage.driver;
    if (!(d instanceof LocalDriver)) throw new NotFoundException();
    return d;
  }

  @Put('local/:token') @HttpCode(200)
  async put(@Param('token') token: string, @Req() req: Request) {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) throw new ForbiddenException('Envio inválido');
    const ok = this.local.verifyPut(token, req.headers['content-type'], body.length);
    if (!ok) throw new ForbiddenException('URL de envio inválida ou expirada');
    await this.local.put(ok.key, body);
    return { ok: true };
  }

  @Get('files/*key')
  async file(@Param('key') key: string | string[], @Res() res: Response) {
    const k = Array.isArray(key) ? key.join('/') : key;
    if (!this.storage.keyOf(`${this.local.publicBase}/${k}`)) throw new NotFoundException();
    if (!(await this.local.head(k))) throw new NotFoundException();
    const ext = k.split('.').pop()!;
    const type = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' } as Record<string, string>)[ext] ?? 'application/octet-stream';
    res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
    createReadStream(this.local.filePath(k)).pipe(res);
  }
}
