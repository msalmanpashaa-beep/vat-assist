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

/**
 * Reminders the day before: VAT return deadlines (to owners), Nex-Gen bookings (to whoever booked) and,
 * if the shop switches it on, customer invoices falling due (to the customer). Each message is queued once
 * (idempotency key), sent at 09:00 Mauritius time, and its delivery status comes back from Twilio.
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
            business: org.name,
            period: periodLabel(period),
            date: ddmmyyyy(tomorrow),
            amount: formatRs(pot.setAsideCents, r.locale),
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
    for (const i of invoices) {
      queued += await this.db.run({ kind: 'system', orgId: i.org_id }, async (tx) => {
        const row = await tx.one<{ business: string; locale: Locale; reference: string | null; phone_e164: string; outstanding_cents: number }>(
          `select coalesce(o.trading_name, o.legal_name) as business, o.default_locale as locale, t.reference, c.phone_e164, v.outstanding_cents
           from transactions t join organisations o on o.id = t.org_id join contacts c on c.id = t.contact_id
           join v_open_items v on v.transaction_id = t.id where t.id = $1`,
          [i.transaction_id],
        );
        // Customers have not opted in to WhatsApp from the shop, so these go by SMS only.
        return this.queue(tx, i.org_id, `invoice:${i.transaction_id}:${tomorrow}`, {
          userId: null, phone: row.phone_e164, locale: row.locale, whatsappOptIn: false, smsOptOut: false,
        }, 'invoice_due_tomorrow', {
          business: row.business, number: row.reference ?? '', amount: formatRs(row.outstanding_cents, row.locale), date: ddmmyyyy(tomorrow),
        }, sendAt);
      });
    }
    if (queued) this.log.log(`Queued ${queued} reminder(s) for ${tomorrow}`);
    return queued;
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

  private async queue(tx: Tx, orgId: string, key: string, r: Recipient, template: TemplateKey, vars: Record<string, string>, sendAt: Date): Promise<number> {
    const contentSid = this.cfg.whatsappContentSids[template]?.[r.locale];
    const channel = r.whatsappOptIn && contentSid ? 'whatsapp' : 'sms';
    const status = channel === 'sms' && r.smsOptOut ? 'skipped' : 'queued';
    const body = renderTemplate(template, r.locale, vars);
    const row = await tx.maybe(
      `insert into outbound_messages (org_id, idempotency_key, channel, to_e164, template_key, locale, variables, body_preview, status, scheduled_for)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (idempotency_key) do nothing returning id`,
      [orgId, key, channel, r.phone, template, r.locale, JSON.stringify(vars), body, status, sendAt],
    );
    return row && status === 'queued' ? 1 : 0;
  }

  async dispatch(now: Date): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const orgs = await this.db.run({ kind: 'system', orgId: null }, (tx) => tx.many<{ org_id: string }>(`select * from app.queued_message_orgs($1)`, [now]));
    for (const { org_id } of orgs) {
      await this.db.run({ kind: 'system', orgId: org_id }, async (tx) => {
        const due = await tx.many<{ id: string; channel: 'sms' | 'whatsapp'; to_e164: string; template_key: TemplateKey; locale: Locale; variables: Record<string, string>; body_preview: string }>(
          `select id, channel, to_e164, template_key, locale, variables, body_preview from outbound_messages
           where status = 'queued' and scheduled_for <= $1 order by scheduled_for limit 100 for update skip locked`,
          [now],
        );
        for (const m of due) {
          try {
            const res = m.channel === 'whatsapp'
              ? await this.messaging.sendWhatsApp(m.to_e164, this.cfg.whatsappContentSids[m.template_key]?.[m.locale] ?? '', positionalVariables(m.template_key, m.variables))
              : await this.messaging.sendSms(m.to_e164, m.body_preview);
            await tx.exec(`update outbound_messages set status = 'sent', provider_sid = $2, sent_at = now() where id = $1`, [m.id, res.sid]);
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
