import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CreateOrgBody, LocaleSchema, OpeningBalancesBody } from '@vat-assist/shared';
import { z } from 'zod';
import { type Actor, CurrentActor, CurrentScope, type OrgScope, Roles, userCtx } from '../../common/auth-context';
import { ZodBody } from '../../common/zod.pipe';
import { Db } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { OrgGuard } from '../core/guards';
import { OrgsService } from './orgs.service';

const InviteBody = z.object({ phone: z.string().min(6).max(20), fullName: z.string().max(120).optional(), locale: LocaleSchema.optional() });

@Controller('orgs')
export class OrgsController {
  constructor(
    private readonly db: Db,
    private readonly orgs: OrgsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  create(@CurrentActor() a: Actor, @Body(new ZodBody(CreateOrgBody)) body: z.output<typeof CreateOrgBody>) {
    return this.orgs.create(a, body);
  }

  @Get(':orgId')
  @UseGuards(OrgGuard)
  get(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), (tx) => this.orgs.get(tx, s.orgId));
  }

  @Post(':orgId/opening-balances')
  @UseGuards(OrgGuard)
  @Roles('owner', 'reviewer', 'senior_reviewer', 'admin')
  opening(@CurrentScope() s: OrgScope, @Body(new ZodBody(OpeningBalancesBody)) body: z.output<typeof OpeningBalancesBody>) {
    return this.orgs.openingBalances(s, body);
  }

  @Get(':orgId/members')
  @UseGuards(OrgGuard)
  members(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), (tx) => this.orgs.members(tx, s.orgId));
  }

  @Post(':orgId/members')
  @UseGuards(OrgGuard)
  @Roles('owner')
  invite(@CurrentScope() s: OrgScope, @Body(new ZodBody(InviteBody)) body: z.output<typeof InviteBody>) {
    return this.orgs.inviteStaff(s, body.phone, body.fullName, body.locale);
  }

  @Get(':orgId/audit/verify')
  @UseGuards(OrgGuard)
  verifyAudit(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), async (tx) => ({ ...(await this.audit.verify(tx, s.orgId)), head: await this.audit.head(tx, s.orgId) }));
  }
}
