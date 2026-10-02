import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AckBody, PaymentConfirmBody, todayIn } from '@vat-assist/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppConfig } from '../../config';
import { CurrentScope, type OrgScope, Roles, userCtx } from '../../common/auth-context';
import { ZodBody } from '../../common/zod.pipe';
import { Db } from '../../db/db.service';
import { OrgGuard } from '../core/guards';
import { FilingService } from './filing.service';
import { ReturnsService } from './returns.service';
import { VatPotService } from './vat-pot.service';

const REVIEWERS = ['reviewer', 'senior_reviewer', 'admin'] as const;

@Controller('orgs/:orgId')
@UseGuards(OrgGuard)
export class VatController {
  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly pot: VatPotService,
    private readonly returns: ReturnsService,
    private readonly filing: FilingService,
  ) {}

  @Get('vat-pot')
  vatPot(@CurrentScope() s: OrgScope, @Query('periodId') periodId?: string) {
    return this.db.run(userCtx(s), (tx) => this.pot.compute(tx, s.orgId, periodId ?? null, todayIn(this.cfg.env.TZ_BUSINESS)));
  }

  @Get('periods')
  periods(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), (tx) => this.returns.periods(tx, s.orgId));
  }

  @Post('periods/:periodId/ready')
  @Roles('owner', 'staff', ...REVIEWERS)
  @HttpCode(200)
  ready(@CurrentScope() s: OrgScope, @Param('periodId') periodId: string) {
    return this.db.run(userCtx(s), (tx) => this.filing.ready(tx, s, periodId));
  }

  @Post('periods/:periodId/returns')
  @Roles(...REVIEWERS)
  draft(@CurrentScope() s: OrgScope, @Param('periodId') periodId: string) {
    return this.db.run(userCtx(s), (tx) => this.returns.draft(tx, s, periodId));
  }

  @Post('periods/:periodId/close')
  @Roles(...REVIEWERS)
  @HttpCode(200)
  close(@CurrentScope() s: OrgScope, @Param('periodId') periodId: string) {
    return this.db.run(userCtx(s), (tx) => this.filing.close(tx, s, periodId));
  }

  @Get('returns/:returnId')
  get(@CurrentScope() s: OrgScope, @Param('returnId') id: string) {
    return this.db.run(userCtx(s), (tx) => this.returns.get(tx, s.orgId, id));
  }

  @Get('returns/:returnId/guide')
  guide(@CurrentScope() s: OrgScope, @Param('returnId') id: string) {
    return this.db.run(userCtx(s), (tx) => this.filing.guideFor(tx, s.orgId, id));
  }

  @Get('returns/:returnId/filing-pack.pdf')
  async pack(@CurrentScope() s: OrgScope, @Param('returnId') id: string, @Res() res: Response) {
    const { filename, pdf } = await this.db.run(userCtx(s), (tx) => this.filing.filingPack(tx, s.orgId, id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  }

  @Post('returns/:returnId/sign-off')
  @Roles('senior_reviewer')
  @HttpCode(200)
  signOff(@CurrentScope() s: OrgScope, @Param('returnId') id: string) {
    return this.db.run(userCtx(s), (tx) => this.returns.signOff(tx, s, id));
  }

  @Post('returns/:returnId/acknowledgement')
  @Roles('owner', 'staff', ...REVIEWERS)
  @HttpCode(200)
  ack(@CurrentScope() s: OrgScope, @Param('returnId') id: string, @Body(new ZodBody(AckBody)) body: z.output<typeof AckBody>) {
    return this.db.run(userCtx(s), (tx) => this.filing.attachAcknowledgement(tx, s, id, body));
  }

  @Post('returns/:returnId/payment')
  @Roles('owner', ...REVIEWERS)
  @HttpCode(200)
  payment(@CurrentScope() s: OrgScope, @Param('returnId') id: string, @Body(new ZodBody(PaymentConfirmBody)) body: z.output<typeof PaymentConfirmBody>) {
    return this.db.run(userCtx(s), (tx) => this.filing.confirmPayment(tx, s, id, body));
  }
}
