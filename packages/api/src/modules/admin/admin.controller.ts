import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type Actor, CurrentActor, userCtx } from '../../common/auth-context';
import { DomainError, forbidden } from '../../common/errors';
import { ZodBody } from '../../common/zod.pipe';
import { Db } from '../../db/db.service';
import { RemindersService } from '../notifications/reminders.service';

const AssignBody = z.object({ userId: z.string().uuid(), role: z.enum(['reviewer', 'senior_reviewer', 'admin', 'support']) });
const MraListBody = z.object({ listDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), csv: z.string().min(10).max(20_000_000) });
const RunBody = z.object({ now: z.string().datetime({ offset: true }).optional() });

/** Platform administration for Nex-Gen: assign reviewers, load MRA's VAT-registered list, run reminders. */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: Db,
    private readonly reminders: RemindersService,
  ) {}

  private async requireAdmin(a: Actor): Promise<void> {
    const ok = await this.db.run(userCtx(a), (tx) =>
      tx.maybe(
        `select 1 from memberships m join organisations o on o.id = m.org_id
         where o.is_platform and m.user_id = $1 and m.role = 'admin' and m.revoked_at is null`,
        [a.userId],
      ),
    );
    if (!ok) throw forbidden('Only Nex-Gen platform admins can do this.');
  }

  @Get('staff')
  async staff(@CurrentActor() a: Actor) {
    await this.requireAdmin(a);
    return this.db.run(userCtx(a), (tx) =>
      tx.many(
        `select u.id, u.full_name, u.email, m.role from memberships m
         join organisations o on o.id = m.org_id and o.is_platform join users u on u.id = m.user_id
         where m.revoked_at is null order by u.full_name`,
      ),
    );
  }

  @Post('orgs/:orgId/staff')
  async assign(@CurrentActor() a: Actor, @Param('orgId') orgId: string, @Body(new ZodBody(AssignBody)) b: z.output<typeof AssignBody>) {
    await this.requireAdmin(a);
    return this.db.run(userCtx(a), (tx) => tx.one(`select app.assign_staff($1, $2, $3) as membership_id`, [orgId, b.userId, b.role]));
  }

  /**
   * MRA publishes the list of VAT-registered persons as a PDF, updated quarterly. Convert it to CSV
   * (vat_number,name,brn) and load it here; suppliers missing from it get a warning, not a block.
   */
  @Post('mra-registered-persons')
  @HttpCode(200)
  async importMraList(@CurrentActor() a: Actor, @Body(new ZodBody(MraListBody)) b: z.output<typeof MraListBody>) {
    await this.requireAdmin(a);
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
    await this.requireAdmin(a);
    return this.reminders.tick(b.now ? new Date(b.now) : new Date());
  }
}
