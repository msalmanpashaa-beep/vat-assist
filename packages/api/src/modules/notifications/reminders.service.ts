import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { addDays, formatRs, type IsoDate, type Locale, positionalVariables, renderTemplate, type TemplateKey, todayIn } from '@vat-assist/shared';
import { AppConfig } from '../../config';
import { Db, type Tx } from '../../db/db.service';
import { JobsService } from '../core/jobs.service';
import { PeriodsService, periodLabel } from '../core/periods.service';
import { VatPotService } from '../vat/vat-pot.service';
import { MESSAGING, type MessagingProvider } from './messaging';

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Mauritius is UTC+4 all year (no daylight saving). */
const MU_OFFSET_HOURS = 4;

interface Recipient {
  userId: string | null;
  phone: string;
  locale: Locale;
  whatsappOptIn: boolean;
  smsOptOut: boolean;
}

/** WhatsApp only with a recorded opt-in AND an approved template; otherwise SMS, unless the number said STOP. */
export function chooseChannel(r: { whatsappOptIn: boolean; hasTemplate: boolean; smsOptOut: boolean }): 'whatsapp' | 'sms' | 'skip' {
  if (r.whatsappOptIn && r.hasTemplate) return 'whatsapp';
  return r.smsOptOut ? 'skip' : 'sms';
}

/**
 * Reminders the day before: VAT return deadlines (to owners), Nex-Gen bookings (to whoever booked) and,
 * when the shop switches them on, customer invoices falling due (to customers who agreed). Each message is
 * queued once (idempotency key) for 09:00 Mauritius time; consent and the amount due are re-checked at send time.
 */
@Injectable()
export class RemindersService implements OnModuleInit {
  private readonly log = new Logger('Reminders');

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly jobs: JobsService,
    private readonly periods: PeriodsService,
    private readonly pot: VatPotService,
    @Inject(MESSAGING) private readonly messaging: MessagingProvider,
  ) {}

  onModuleInit(): void {
    this.jobs.register('reminders.tick', async () => {
      await this.tick(new Date());
    });
    // A new credit invoice: schedule its reminder now (no-op unless the shop has reminders on).
    this.jobs.register('reminders.invoice_created', async (d) => {
      await this.scheduleInvoiceReminders(String(d.orgId), String(d.transactionId));
    });
  }

  /** 09:00 (or REMINDER_SEND_HOUR_LOCAL) Mauritius time on `day`, as a UTC instant. */
  private sendAt(day: IsoDate): Date {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d, this.cfg.env.REMINDER_SEND_HOUR_LOCAL - MU_OFFSET_HOURS, 0, 0));
  }

  async tick(now: Date): Promise<{ queued: number; sent: number; failed: number }> {
    const queued = await this.plan(now);
    const { sent, failed } = await this.dispatch(now);
    return { queued, sent, failed };
  }

  /** Shop setting on AND the Nex-Gen feature flag not switched off. */
  private async invoiceRemindersOn(tx: Tx, orgId: string): Promise<boolean> {
    const r = await tx.one<{ on: boolean }>(
      `select o.debtor_reminders_enabled
              and coalesce((select f.enabled from org_features f where f.org_id = o.id and f.feature = 'invoice_reminders'), true) as on
       from organisations o where o.id = $1`,
      [orgId],
    );
    return r.on;
  }

  async plan(now: Date): Promise<number> {
    const today = todayIn(this.cfg.env.TZ_BUSINESS, now);
    const tomorrow = addDays(today, 1);
    const sendAt = this.sendAt(today);
    let queued = 0;

    const vat = await this.db.run({ kind: 'system', orgId: null }, (tx) =>
      tx.many<{ org_id: string; period_id: string; deadline_kind: string }>(`select * from app.reminder_vat_candidates($1::date)`, [tomorrow]),
    );
    for (const c of vat) {
      queued += await this.db.run({ kind: 'system', orgId: c.org_id }, async (tx) => {
        const org = await tx.one<{ name: string }>(`select coalesce(trading_name, legal_name) as name from organisations where id = $1`, [c.org_id]);
        const period = await this.periods.byId(tx, c.period_id);
        const pot = await this.pot.compute(tx, c.org_id, c.period_id, today);
        let n = 0;
        for (const r of await this.owners(tx, c.org_id)) {
          n += await this.queue(tx, c.org_id, `vat:${c.period_id}:${c.deadline_kind}:${r.userId}:${tomorrow}`, r, 'vat_due_tomorrow', {
            business: org.name, period: periodLabel(period), date: ddmmyyyy(tomorrow), amount: formatRs(pot.setAsideCents, r.locale),
          }, sendAt);
        }
        return n;
      });
    }

    const fromUtc = new Date(this.sendAt(tomorrow).getTime() - this.cfg.env.REMINDER_SEND_HOUR_LOCAL * 3_600_000);
    const toUtc = new Date(fromUtc.getTime() + 86_400_000);
    const bookings = await this.db.run({ kind: 'system', orgId: null }, (tx) =>
      tx.many<{ org_id: string; booking_id: string }>(`select * from app.reminder_booking_candidates($1, $2)`, [fromUtc, toUtc]),
    );
    for (const b of bookings) {
      queued += await this.db.run({ kind: 'system', orgId: b.org_id }, async (tx) => {
        const row = await tx.one<{ starts_at: Date; phone_e164: string | null; locale: Locale; user_id: string; whatsapp_opt_in_at: Date | null; sms_opt_out_at: Date | null }>(
          `select b.starts_at, u.phone_e164, u.locale, u.id as user_id, u.whatsapp_opt_in_at, u.sms_opt_out_at
           from bookings b join users u on u.id = b.created_by where b.id = $1`,
          [b.booking_id],
        );
        if (!row.phone_e164) return 0;
        const local = new Date(row.starts_at.getTime() + MU_OFFSET_HOURS * 3_600_000).toISOString();
        return this.queue(tx, b.org_id, `booking:${b.booking_id}:${tomorrow}`, {
          userId: row.user_id, phone: row.phone_e164, locale: row.locale, whatsappOptIn: !!row.whatsapp_opt_in_at, smsOptOut: !!row.sms_opt_out_at,
        }, 'booking_tomorrow', { date: ddmmyyyy(local.slice(0, 10)), time: local.slice(11, 16) }, sendAt);
      });
    }

    const invoices = await this.db.run({ kind: 'system', orgId: null }, (tx) =>
      tx.many<{ org_id: string; transaction_id: string }>(`select * from app.reminder_invoice_candidates($1::date)`, [tomorrow]),
    );
    for (const i of invoices) queued += await this.scheduleInvoiceReminders(i.org_id, i.transaction_id, now);
    if (queued) this.log.log(`Queued ${queued} reminder(s) for ${tomorrow}`);
    return queued;
  }

  /**
   * Queue the day-before reminder for open credit invoices of one shop (or one invoice). Uses the same key as
   * the daily planner, so an invoice is never reminded twice. Returns how many were newly scheduled.
   */
  async scheduleInvoiceReminders(orgId: string, onlyTransactionId?: string, now = new Date()): Promise<number> {
    const today = todayIn(this.cfg.env.TZ_BUSINESS, now);
    return this.db.run({ kind: 'system', orgId }, async (tx) => {
      if (!(await this.invoiceRemindersOn(tx, orgId))) return 0;
      const org = await tx.one<{ name: string; locale: Locale }>(`select coalesce(trading_name, legal_name) as name, default_locale as locale from organisations where id = $1`, [orgId]);
      const rows = await tx.many<{ id: string; reference: string | null; due_date: string; phone_e164: string; outstanding_cents: number }>(
        `select t.id, t.reference, t.due_date, c.phone_e164, v.outstanding_cents
         from transactions t
         join contacts c on c.id = t.contact_id and c.phone_e164 is not null and c.reminder_consent_at is not null
         join v_open_items v on v.transaction_id = t.id
         where t.org_id = $1 and t.kind = 'sales_invoice' and t.status = 'posted' and t.settlement = 'credit'
           and t.due_date > $2::date and v.outstanding_cents > 0 and ($3::uuid is null or t.id = $3::uuid)`,
        [orgId, today, onlyTransactionId ?? null],
      );
      let n = 0;
      for (const r of rows) {
        n += await this.queue(tx, orgId, `invoice:${r.id}:${r.due_date}`, {
          userId: null, phone: r.phone_e164, locale: org.locale, whatsappOptIn: false, smsOptOut: false,
        }, 'invoice_due_tomorrow', {
          business: org.name, number: r.reference ?? '', amount: formatRs(r.outstanding_cents, org.locale), date: ddmmyyyy(r.due_date),
        }, this.sendAt(addDays(r.due_date, -1)), r.id);
      }
      return n;
    });
  }

  /** Switching reminders off cancels everything already scheduled for customers of that shop. */
  async cancelInvoiceReminders(orgId: string): Promise<number> {
    return this.db.run({ kind: 'system', orgId }, (tx) =>
      tx.exec(`update outbound_messages set status = 'cancelled', error = 'reminders switched off' where org_id = $1 and template_key = 'invoice_due_tomorrow' and status = 'queued'`, [orgId]),
    );
  }

  async list(orgId: string, status?: string) {
    return this.db.run({ kind: 'system', orgId }, (tx) =>
      tx.many(
        `select id, template_key, channel, to_e164, scheduled_for, status, body_preview, transaction_id, sent_at, error
         from outbound_messages where org_id = $1 and ($2::text is null or status = $2) order by scheduled_for desc limit 200`,
        [orgId, status ?? null],
      ),
    );
  }

  /** Queue a message to a business's owners now (e.g. "a customer says they paid"); sent by the next dispatch. */
  async notifyOwners(tx: Tx, orgId: string, key: string, template: TemplateKey, varsFor: (locale: Locale) => Record<string, string>): Promise<number> {
    let n = 0;
    for (const r of await this.owners(tx, orgId)) n += await this.queue(tx, orgId, `${key}:${r.userId}`, r, template, varsFor(r.locale), new Date());
    return n;
  }

  private async owners(tx: Tx, orgId: string): Promise<Recipient[]> {
    const rows = await tx.many<{ id: string; phone_e164: string | null; locale: Locale; whatsapp_opt_in_at: Date | null; sms_opt_out_at: Date | null }>(
      `select u.id, u.phone_e164, u.locale, u.whatsapp_opt_in_at, u.sms_opt_out_at
       from memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.role = 'owner' and m.revoked_at is null and u.disabled_at is null`,
      [orgId],
    );
    return rows.filter((r) => r.phone_e164).map((r) => ({
      userId: r.id, phone: r.phone_e164 as string, locale: r.locale, whatsappOptIn: !!r.whatsapp_opt_in_at, smsOptOut: !!r.sms_opt_out_at,
    }));
  }

  private async queue(
    tx: Tx, orgId: string, key: string, r: Recipient, template: TemplateKey, vars: Record<string, string>, sendAt: Date, transactionId: string | null = null,
  ): Promise<number> {
    const channel = chooseChannel({ whatsappOptIn: r.whatsappOptIn, hasTemplate: !!this.cfg.whatsappContentSids[template]?.[r.locale], smsOptOut: r.smsOptOut });
    const body = renderTemplate(template, r.locale, vars);
    const row = await tx.maybe(
      `insert into outbound_messages (org_id, idempotency_key, channel, to_e164, template_key, locale, variables, body_preview, status, scheduled_for, user_id, transaction_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (idempotency_key) do update
         set status = excluded.status, scheduled_for = excluded.scheduled_for, body_preview = excluded.body_preview,
             variables = excluded.variables, channel = excluded.channel, error = null
         where outbound_messages.status = 'cancelled'
       returning id`,
      [orgId, key, channel === 'whatsapp' ? 'whatsapp' : 'sms', r.phone, template, r.locale, JSON.stringify(vars), body,
        channel === 'skip' ? 'skipped' : 'queued', sendAt, r.userId, transactionId],
    );
    return row && channel !== 'skip' ? 1 : 0;
  }

  async dispatch(now: Date): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const orgs = await this.db.run({ kind: 'system', orgId: null }, (tx) => tx.many<{ org_id: string }>(`select * from app.queued_message_orgs($1)`, [now]));
    for (const { org_id } of orgs) {
      await this.db.run({ kind: 'system', orgId: org_id }, async (tx) => {
        const due = await tx.many<{
          id: string; channel: 'sms' | 'whatsapp'; to_e164: string; template_key: TemplateKey; locale: Locale;
          variables: Record<string, string>; body_preview: string; user_id: string | null; transaction_id: string | null;
        }>(
          `select id, channel, to_e164, template_key, locale, variables, body_preview, user_id, transaction_id from outbound_messages
           where status = 'queued' and scheduled_for <= $1 order by scheduled_for limit 100 for update skip locked`,
          [now],
        );
        for (const m of due) {
          let vars = m.variables;
          let body = m.body_preview;
          if (m.template_key === 'invoice_due_tomorrow' && m.transaction_id) {
            // Paid since it was scheduled, consent withdrawn, or reminders switched off: do not chase the customer.
            const live = await tx.maybe<{ outstanding_cents: number; consent: boolean }>(
              `select v.outstanding_cents, (c.reminder_consent_at is not null) as consent
               from v_open_items v join transactions t on t.id = v.transaction_id join contacts c on c.id = t.contact_id
               where v.transaction_id = $1`,
              [m.transaction_id],
            );
            if (!live || live.outstanding_cents <= 0 || !live.consent || !(await this.invoiceRemindersOn(tx, org_id))) {
              await tx.exec(`update outbound_messages set status = 'cancelled', error = 'paid, consent withdrawn or reminders off' where id = $1`, [m.id]);
              continue;
            }
            vars = { ...vars, amount: formatRs(live.outstanding_cents, m.locale) };
            body = renderTemplate(m.template_key, m.locale, vars);
          }
          let channel: 'sms' | 'whatsapp' | 'skip' = m.channel;
          if (m.user_id) {
            const u = await tx.maybe<{ whatsapp_opt_in_at: Date | null; sms_opt_out_at: Date | null }>(
              `select whatsapp_opt_in_at, sms_opt_out_at from users where id = $1`,
              [m.user_id],
            );
            channel = chooseChannel({ whatsappOptIn: !!u?.whatsapp_opt_in_at, hasTemplate: !!this.cfg.whatsappContentSids[m.template_key]?.[m.locale], smsOptOut: !!u?.sms_opt_out_at });
          }
          if (channel === 'skip') {
            await tx.exec(`update outbound_messages set status = 'skipped', error = 'opted out' where id = $1`, [m.id]);
            continue;
          }
          try {
            const res = channel === 'whatsapp'
              ? await this.messaging.sendWhatsApp(m.to_e164, this.cfg.whatsappContentSids[m.template_key]?.[m.locale] ?? '', positionalVariables(m.template_key, vars))
              : await this.messaging.sendSms(m.to_e164, body);
            await tx.exec(
              `update outbound_messages set status = 'sent', channel = $2, provider_sid = $3, sent_at = now(), body_preview = $4 where id = $1`,
              [m.id, channel, res.sid, body],
            );
            sent++;
          } catch (e) {
            await tx.exec(`update outbound_messages set status = 'failed', error = $2 where id = $1`, [m.id, e instanceof Error ? e.message : String(e)]);
            failed++;
          }
        }
      });
    }
    return { sent, failed };
  }
}
