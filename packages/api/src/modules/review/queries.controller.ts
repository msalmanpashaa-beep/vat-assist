import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { QueryCreateBody, QueryReplyBody } from '@vat-assist/shared';
import type { z } from 'zod';
import { CurrentScope, type OrgScope, Roles, userCtx } from '../../common/auth-context';
import { ZodBody } from '../../common/zod.pipe';
import { Db } from '../../db/db.service';
import { OrgGuard } from '../core/guards';
import { QueriesService } from './queries.service';

@Controller('orgs/:orgId/queries')
@UseGuards(OrgGuard)
export class QueriesController {
  constructor(
    private readonly db: Db,
    private readonly queries: QueriesService,
  ) {}

  @Get()
  list(@CurrentScope() s: OrgScope, @Query('status') status?: string) {
    return this.db.run(userCtx(s), (tx) => this.queries.list(tx, s.orgId, status));
  }

  @Get(':id')
  thread(@CurrentScope() s: OrgScope, @Param('id') id: string) {
    return this.db.run(userCtx(s), (tx) => this.queries.thread(tx, s.orgId, id));
  }

  @Post()
  create(@CurrentScope() s: OrgScope, @Body(new ZodBody(QueryCreateBody)) body: z.output<typeof QueryCreateBody>) {
    return this.db.run(userCtx(s), (tx) => this.queries.create(tx, s, body));
  }

  @Post(':id/messages')
  reply(@CurrentScope() s: OrgScope, @Param('id') id: string, @Body(new ZodBody(QueryReplyBody)) body: z.output<typeof QueryReplyBody>) {
    return this.db.run(userCtx(s), (tx) => this.queries.reply(tx, s, id, body));
  }

  @Post(':id/resolve')
  @Roles('reviewer', 'senior_reviewer', 'admin')
  @HttpCode(200)
  resolve(@CurrentScope() s: OrgScope, @Param('id') id: string) {
    return this.db.run(userCtx(s), (tx) => this.queries.resolve(tx, s, id));
  }
}
