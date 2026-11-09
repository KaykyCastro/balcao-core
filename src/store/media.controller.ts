import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { MediaService } from './media.service';

/**
 * Biblioteca de vídeos da vitrine (topo da loja e "vídeos que vendem").
 * O envio é direto para o R2: POST /uploads/presign (kind 'video') e POST /uploads/:id/complete.
 */
@Controller('store-config/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(@CurrentEnterprise() eid: string) { return this.media.list(eid); }

  @Delete(':id') @HttpCode(200)
  remove(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.media.remove(eid, id); }
}
