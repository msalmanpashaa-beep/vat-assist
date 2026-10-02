import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DailyTakingsBody, PaymentBody, ReasonBody, SalesInvoiceBody, todayIn } from '@vat-assist/shared';
import type { z } from 'zod';
import { AppConfig } from '../../config';
import { CurrentScope, type OrgScope, Roles, userCtx } from '../../common/auth-context';
import { ZodBody } from '../../common/zod.pipe';
import { Db } from '../../db/db.service';
import { OrgGuard } from '../core/guards';
import { LedgerService } from './ledger.service';
import { TransactionsService } from './transactions.service';

const WRITERS = ['owner', 'staff', 'reviewer', 'senior_reviewer', 'admin'] as const;

@Controller('orgs/:orgId')
@UseGuards(OrgGuard)
export class TransactionsController {
  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly txns: TransactionsService,
    private readonly ledger: LedgerService,
  ) {}

  @Post('daily-takings')
  @Roles(...WRITERS)
  dailyTakings(@CurrentScope() s: OrgScope, @Body(new ZodBody(DailyTakingsBody)) body: z.output<typeof DailyTakingsBody>) {
    return this.db.run(userCtx(s), (tx) => this.txns.dailyTakings(tx, s.userId, s.orgId, body));
  }

  @Post('sales-invoices')
  @Roles(...WRITERS)
  salesInvoice(@CurrentScope() s: OrgScope, @Body(new ZodBody(SalesInvoiceBody)) body: z.output<typeof SalesInvoiceBody>) {
    return this.db.run(userCtx(s), (tx) => this.txns.salesInvoice(tx, s.userId, s.orgId, body));
  }

  @Post('payments')
  @Roles('owner', 'reviewer', 'senior_reviewer', 'admin')
  payment(@CurrentScope() s: OrgScope, @Body(new ZodBody(PaymentBody)) body: z.output<typeof PaymentBody>) {
    return this.db.run(userCtx(s), (tx) => this.txns.recordPayment(tx, s.userId, s.orgId, body));
  }

  @Post('transactions/:id/void')
  @Roles('owner', 'reviewer', 'senior_reviewer', 'admin')
  async void(@CurrentScope() s: OrgScope, @Param('id') id: string, @Body(new ZodBody(ReasonBody)) body: z.output<typeof ReasonBody>) {
    await this.db.run(userCtx(s), (tx) => this.ledger.voidTransaction(tx, s.userId, id, body.reason, todayIn(this.cfg.env.TZ_BUSINESS)));
    return { voided: true };
  }

  @Get('transactions')
  list(@CurrentScope() s: OrgScope, @Query('status') status?: string, @Query('kind') kind?: string) {
    return this.db.run(userCtx(s), (tx) => this.txns.list(tx, s.orgId, { status, kind }));
  }

  @Get('ageing')
  ageing(@CurrentScope() s: OrgScope, @Query('side') side = 'receivable', @Query('asOf') asOf?: string, @Query('basis') basis = 'invoice_date') {
    const sideV = side === 'payable' ? 'payable' : 'receivable';
    const basisV = basis === 'due_date' ? 'due_date' : 'invoice_date';
    const date = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : todayIn(this.cfg.env.TZ_BUSINESS);
    return this.db.run(userCtx(s), (tx) => this.txns.ageing(tx, s.orgId, sideV, date, basisV));
  }

  @Get('contacts')
  contacts(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), (tx) =>
      tx.many(`select id, kind, name, vat_number, phone_e164, payment_terms_days, default_category from contacts where org_id = $1 order by name`, [s.orgId]),
    );
  }
}
