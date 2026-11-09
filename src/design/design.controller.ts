import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { IsBoolean, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { DesignService } from './design.service';

class RequestDto { @IsMongoId() enterpriseId!: string; @IsOptional() @IsString() @MaxLength(500) message?: string }
class ListDto { @IsMongoId() enterpriseId!: string }
class DecideDto { @IsBoolean() allow!: boolean }

const actor = (req: { user: { _id: unknown; email: string } }) => ({ id: String(req.user._id), email: req.user.email });

/** Admin: pede acesso ao design de uma loja, abre a sessão (só depois do "sim") e finaliza. */
@Roles('admin')
@Controller('admin/design')
export class AdminDesignController {
  constructor(private readonly design: DesignService) {}

  @Get() list(@Query() q: ListDto) { return this.design.listFor(q.enterpriseId); }
  @Post() request(@Req() req: any, @Body() dto: RequestDto) { return this.design.request(actor(req), dto.enterpriseId, dto.message ?? ''); }
  @Post(':id/cancel') @HttpCode(200) cancel(@Req() req: any, @Param('id', ParseMongoIdPipe) id: string) { return this.design.cancel(actor(req), id); }
  /** Token da sessão de edição: vai no cabeçalho X-Design-Session e só alcança as rotas de design. */
  @Post(':id/session') @HttpCode(200) session(@Req() req: any, @Param('id', ParseMongoIdPipe) id: string) { return this.design.startSession(actor(req), id); }
  @Post(':id/finish') @HttpCode(200) finish(@Req() req: any, @Param('id', ParseMongoIdPipe) id: string) { return this.design.finish(actor(req), id); }
}

/** Lojista (só o dono: não há regra de colaborador para /design-access): vê o pedido, permite uma vez, recusa ou revoga. */
@Controller('design-access')
export class StoreDesignController {
  constructor(private readonly design: DesignService) {}

  @Get() current(@CurrentEnterprise() eid: string) { return this.design.currentFor(eid); }
  @Post(':id/decide') @HttpCode(200) decide(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: DecideDto) { return this.design.decide(eid, id, dto.allow); }
  @Post(':id/revoke') @HttpCode(200) revoke(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.design.revoke(eid, id); }
}
