import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { StaffService, type StaffSession } from './staff.service';
import { AccessLogQueryDto, MetricsQueryDto, ShiftStartDto, ShiftsQueryDto, StaffCreateDto, StaffUpdateDto } from './dto/staff.dto';

type Rq = { user: { staff?: StaffSession } };
const me = (req: Rq) => { if (!req.user.staff) throw new ForbiddenException('Só para colaboradores'); return req.user.staff; };

/** Colaboradores: só o dono (o guard de funcionários recusa /staff para funcionários, menos /staff/me e /staff/shift). */
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get() list(@CurrentEnterprise() eid: string) { return this.staff.list(eid); }
  @Post() create(@CurrentEnterprise() eid: string, @Body() dto: StaffCreateDto) { return this.staff.create(eid, dto); }
  @Get('shifts') shifts(@CurrentEnterprise() eid: string, @Query() q: ShiftsQueryDto) { return this.staff.shiftHistory(eid, q.staffId); }
  /** Desempenho por colaborador (1, 7, 30 ou 90 dias). */
  @Get('metrics') metrics(@CurrentEnterprise() eid: string, @Query() q: MetricsQueryDto) { return this.staff.metrics(eid, q.days ?? 30); }
  /** Registro de acessos: entradas, senha errada, tentativas fora do horário, turnos. */
  @Get('access-log') accessLog(@CurrentEnterprise() eid: string, @Query() q: AccessLogQueryDto) { return this.staff.accessLog(eid, q); }

  // ---- funcionário logado
  @AllowWhenBlocked() @Get('me') mine(@CurrentEnterprise() eid: string, @Req() req: Rq) { return this.staff.me(eid, me(req)); }
  @AllowWhenBlocked() @Post('shift/start') @HttpCode(200) start(@CurrentEnterprise() eid: string, @Req() req: Rq, @Body() dto: ShiftStartDto) { return this.staff.startShift(eid, me(req), dto.tables); }
  @AllowWhenBlocked() @Put('shift/tables') tables(@CurrentEnterprise() eid: string, @Req() req: Rq, @Body() dto: ShiftStartDto) { return this.staff.setTables(eid, me(req), dto.tables ?? []); }
  @AllowWhenBlocked() @Post('shift/end') @HttpCode(200) end(@CurrentEnterprise() eid: string, @Req() req: Rq) { return this.staff.endShift(eid, me(req)); }

  @Patch(':id') update(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: StaffUpdateDto) { return this.staff.update(eid, id, dto); }
  @Post(':id/logout') @HttpCode(200) kick(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.staff.kick(eid, id); }
}
