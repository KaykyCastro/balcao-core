import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Put } from '@nestjs/common';
import { EnterpriseService } from './enterprise.service';
import { EnterpriseUpdateDto } from './dto/enterprise.update.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';

/** Cadastro é feito em POST /auth/register. Aqui a empresa só enxerga/altera a si mesma. */
@Controller('enterprise')
export class EnterpriseController {
  constructor(private readonly enterpriseService: EnterpriseService) {}

  private assertOwn(id: string, current: string) {
    if (id !== current) throw new ForbiddenException('Acesso negado');
  }

  @Get(':id')
  async findById(@Param('id', ParseMongoIdPipe) id: string, @CurrentEnterprise() current: string) {
    this.assertOwn(id, current);
    return this.enterpriseService.findEnterpriseById(id);
  }

  /** Trocar e-mail ou senha exige `currentPassword`. */
  @Put(':id')
  async update(@Param('id', ParseMongoIdPipe) id: string, @Body() dto: EnterpriseUpdateDto, @CurrentEnterprise() current: string) {
    this.assertOwn(id, current);
    return this.enterpriseService.update(id, dto);
  }

  /** Exige a senha no corpo. Apaga produtos, clientes e vendas; faturas ficam como registro financeiro. */
  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id', ParseMongoIdPipe) id: string, @Body() dto: DeleteAccountDto, @CurrentEnterprise() current: string) {
    this.assertOwn(id, current);
    await this.enterpriseService.delete(id, dto.password);
  }
}
