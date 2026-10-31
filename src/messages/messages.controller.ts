import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MessagesService } from './messages.service';
import { InboxQuery } from './messages.dto';
import { AllowWhenBlocked } from '../common/decorators/allow-when-blocked.decorator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';

/** Avisos do administrador. Disponíveis mesmo com a conta bloqueada (é por aqui que o admin explica o bloqueio). */
@AllowWhenBlocked()
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  inbox(@CurrentEnterprise() eid: string, @Query() q: InboxQuery) { return this.messages.inbox(eid, q); }

  @Get('unread-count')
  async unread(@CurrentEnterprise() eid: string) { return { unread: await this.messages.unreadCount(eid) }; }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('read-all') @HttpCode(200)
  readAll(@CurrentEnterprise() eid: string) { return this.messages.markAllRead(eid); }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':id/read') @HttpCode(200)
  read(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string) { return this.messages.markRead(eid, id); }
}
