import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { AssignStaffBody, BulkReassignBody, FeatureFlagsBody, StaffInviteBody, TestEmailBody } from '@vat-assist/shared';
import { z } from 'zod';
import { type Actor, CurrentActor, userCtx } from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { ZodBody } from '../../common/zod.pipe';
import { Db } from '../../db/db.service';
import { RemindersService } from '../notifications/reminders.service';
import { AdminService } from './admin.service';

const MraListBody = z.object({ listDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), csv: z.string().min(10).max(20_000_000) });
const RunBody = z.object({ now: z.string().datetime({ offset: true }).optional() });

/** Nex-Gen platform administration: staff, sign-in controls, client assignments, feature flags, operations. */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: Db,
    private readonly admin: AdminService,
    private readonly reminders: RemindersService,
  ) {}

  @Get('staff')
  staff(@CurrentActor() a: Actor) {
    return this.admin.staff(a);
  }

  @Post('staff')
  invite(@CurrentActor() a: Actor, @Body(new ZodBody(StaffInviteBody)) b: z.output<typeof StaffInviteBody>) {
    return this.admin.invite(a, b.email, b.fullName, b.role, b.orgIds);
  }

  /** Sends a test email through the configured provider (to yourself unless another address is given). */
  @Post('mail/test')
  @HttpCode(200)
  testEmail(@CurrentActor() a: Actor, @Body(new ZodBody(TestEmailBody)) b: z.output<typeof TestEmailBody>) {
    return this.admin.testEmail(a, b.to);
  }

  /** A new one-time link: for an invite that expired, or to let someone set a new password. */
  @Post('staff/:userId/invite')
  @HttpCode(200)
  resend(@CurrentActor() a: Actor, @Param('userId') userId: string) {
    return this.admin.resendInvite(a, userId);
  }

  @Post('staff/:userId/reset-2fa')
  @HttpCode(200)
  reset2fa(@CurrentActor() a: Actor, @Param('userId') userId: string) {
    return this.admin.resetTwoFactor(a, userId);
  }

  @Post('staff/:userId/recovery-code')
  @HttpCode(200)
  recovery(@CurrentActor() a: Actor, @Param('userId') userId: string) {
    return this.admin.recoveryCode(a, userId);
  }

  @Post('staff/:userId/disable')
  @HttpCode(200)
  disable(@CurrentActor() a: Actor, @Param('userId') userId: string) {
    return this.admin.setDisabled(a, userId, true);
  }

  @Post('staff/:userId/enable')
  @HttpCode(200)
  enable(@CurrentActor() a: Actor, @Param('userId') userId: string) {
    return this.admin.setDisabled(a, userId, false);
  }

  @Get('clients')
  clients(@CurrentActor() a: Actor) {
    return this.admin.clients(a);
  }

  @Post('orgs/:orgId/staff')
  assign(@CurrentActor() a: Actor, @Param('orgId') orgId: string, @Body(new ZodBody(AssignStaffBody)) b: z.output<typeof AssignStaffBody>) {
    return this.admin.assign(a, orgId, b.userId, b.role);
  }

  @Delete('orgs/:orgId/staff/:userId')
  unassign(@CurrentActor() a: Actor, @Param('orgId') orgId: string, @Param('userId') userId: string) {
    return this.admin.unassign(a, orgId, userId);
  }

  @Post('assignments/bulk')
  @HttpCode(200)
  bulk(@CurrentActor() a: Actor, @Body(new ZodBody(BulkReassignBody)) b: z.output<typeof BulkReassignBody>) {
    return this.admin.bulkReassign(a, b.orgIds, b.toUserId, b.role, b.fromUserId);
  }

  @Put('orgs/:orgId/features')
  features(@CurrentActor() a: Actor, @Param('orgId') orgId: string, @Body(new ZodBody(FeatureFlagsBody)) b: z.output<typeof FeatureFlagsBody>) {
    return this.admin.setFeatures(a, orgId, b.features);
  }

  /** MRA's quarterly list of VAT-registered persons, converted to CSV (vat_number,name,brn). */
  @Post('mra-registered-persons')
  @HttpCode(200)
  async importMraList(@CurrentActor() a: Actor, @Body(new ZodBody(MraListBody)) b: z.output<typeof MraListBody>) {
    await this.admin.requireAdmin(a);
    const rows = b.csv
      .split(/\r?\n/)
      .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
      .filter((c) => /^\d{8}$/.test(c[0] ?? '') && c[1]);
    if (!rows.length) throw new DomainError('empty_list', 'No rows with an 8-digit VAT number were found.', 400);
    await this.db.run(userCtx(a), async (tx) => {
      for (const [vat, name, brn] of rows) {
        await tx.exec(
          `insert into mra_registered_persons (vat_number, name, brn, list_date) values ($1, $2, $3, $4)
           on conflict (vat_number) do update set name = excluded.name, brn = excluded.brn, list_date = excluded.list_date, imported_at = now()`,
          [vat, name, brn || null, b.listDate],
        );
      }
    });
    return { imported: rows.length };
  }

  /** Runs the reminder planner and sender now (production runs it every 15 minutes through BullMQ). */
  @Post('reminders/run')
  @HttpCode(200)
  async runReminders(@CurrentActor() a: Actor, @Body(new ZodBody(RunBody)) b: z.output<typeof RunBody>) {
    await this.admin.requireAdmin(a);
    return this.reminders.tick(b.now ? new Date(b.now) : new Date());
  }
}
