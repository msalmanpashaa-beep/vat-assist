import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ContactBody, ContactPatchBody, OrgSettingsBody, WHATSAPP_CONSENT, WhatsAppConsentBody } from '@vat-assist/shared';
import type { z } from 'zod';
import { CurrentScope, type OrgScope, Roles, userCtx } from '../../common/auth-context';
import { conflict } from '../../common/errors';
import { ZodBody } from '../../common/zod.pipe';
import { Db } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { FeaturesService } from '../core/features.service';
import { OrgGuard } from '../core/guards';
import { findOrCreateContact } from '../ledger/contacts';
import { RemindersService } from '../notifications/reminders.service';

const WRITERS = ['owner', 'staff', 'reviewer', 'senior_reviewer', 'admin'] as const;

/** What the owner screens need beyond the books: flags, settings, contacts, balances, consent. */
@Controller('orgs/:orgId')
@UseGuards(OrgGuard)
export class OwnerController {
  constructor(
    private readonly db: Db,
    private readonly features: FeaturesService,
    private readonly reminders: RemindersService,
    private readonly audit: AuditService,
  ) {}

  @Get('features')
  featureSet(@CurrentScope() s: OrgScope) {
    return this.features.get(s.orgId);
  }

  /** What was entered as opening balances, read back from the posted opening entry. */
  @Get('opening-balances')
  opening(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), async (tx) => {
      const org = await tx.one<{ start_date: string; opening_vat_credit_cents: number }>(`select start_date, opening_vat_credit_cents from organisations where id = $1`, [s.orgId]);
      const accounts = await tx.many<{ tag: string | null; name: string; net_cents: number }>(
        `select a.system_tag as tag, a.name, sum(jl.debit_cents - jl.credit_cents)::bigint as net_cents
         from journal_entries je join journal_lines jl on jl.entry_id = je.id join accounts a on a.id = jl.account_id
         where je.org_id = $1 and je.source_type = 'opening' group by a.system_tag, a.name, a.code order by a.code`,
        [s.orgId],
      );
      const openItems = await tx.many(
        `select t.id, c.name, t.issue_date, t.gross_cents, t.open_item_side as side
         from transactions t left join contacts c on c.id = t.contact_id
         where t.org_id = $1 and t.kind = 'opening_balance' and t.status = 'posted' order by t.open_item_side, c.name`,
        [s.orgId],
      );
      return { recorded: accounts.length > 0 || openItems.length > 0, startDate: org.start_date, vatCreditCarriedForwardCents: org.opening_vat_credit_cents, accounts, openItems };
    });
  }

  /** Cash, bank and each clearing account, straight from the journal. */
  @Get('balances')
  balances(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), (tx) =>
      tx.many(
        `select a.system_tag as tag, a.name, coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint as balance_cents
         from accounts a left join journal_lines jl on jl.account_id = a.id
         where a.org_id = $1 and a.system_tag in ('cash', 'bank', 'juice_clearing', 'card_clearing', 'mips_clearing', 'stripe_clearing')
         group by a.system_tag, a.name, a.code order by a.code`,
        [s.orgId],
      ),
    );
  }

  @Post('contacts')
  @Roles(...WRITERS)
  createContact(@CurrentScope() s: OrgScope, @Body(new ZodBody(ContactBody)) b: z.output<typeof ContactBody>) {
    return this.db.run(userCtx(s), async (tx) => {
      const c = await findOrCreateContact(tx, s.orgId, { name: b.name, kind: b.kind, phone: b.phone ?? null });
      await tx.exec(
        `update contacts set phone_e164 = coalesce($3, phone_e164), payment_terms_days = coalesce($4, payment_terms_days),
                reminder_consent_at = case when $5::boolean is true then coalesce(reminder_consent_at, now()) when $5::boolean is false then null else reminder_consent_at end
         where id = $1 and org_id = $2`,
        [c.id, s.orgId, b.phone ?? null, b.paymentTermsDays ?? null, b.reminderConsent ?? null],
      );
      await this.audit.log(tx, 'contact.saved', 'contact', c.id, { kind: b.kind, created: c.created, reminderConsent: b.reminderConsent ?? null });
      return { id: c.id, created: c.created };
    });
  }

  @Patch('contacts/:id')
  @Roles(...WRITERS)
  async patchContact(@CurrentScope() s: OrgScope, @Param('id') id: string, @Body(new ZodBody(ContactPatchBody)) b: z.output<typeof ContactPatchBody>) {
    const n = await this.db.run(userCtx(s), async (tx) => {
      const n = await tx.exec(
        `update contacts set
           phone_e164 = case when $3::boolean then $4 else phone_e164 end,
           payment_terms_days = case when $5::boolean then $6 else payment_terms_days end,
           reminder_consent_at = case when $7::boolean is true then coalesce(reminder_consent_at, now()) when $7::boolean is false then null else reminder_consent_at end
         where id = $1 and org_id = $2`,
        [id, s.orgId, b.phone !== undefined, b.phone ?? null, b.paymentTermsDays !== undefined, b.paymentTermsDays ?? null, b.reminderConsent ?? null],
      );
      if (n && b.reminderConsent === false) {
        await tx.exec(
          `update outbound_messages set status = 'cancelled', error = 'customer withdrew consent'
           where org_id = $1 and status = 'queued' and transaction_id in (select t.id from transactions t where t.contact_id = $2)`,
          [s.orgId, id],
        );
      }
      if (n) await this.audit.log(tx, 'contact.updated', 'contact', id, { fields: Object.keys(b) });
      return n;
    });
    if (!n) throw new NotFoundException('Contact not found');
    return { id, updated: true };
  }

  @Get('settings')
  settings(@CurrentScope() s: OrgScope) {
    return this.db.run(userCtx(s), async (tx) => {
      const o = await tx.one<{ debtor_reminders_enabled: boolean; default_locale: string }>(`select debtor_reminders_enabled, default_locale from organisations where id = $1`, [s.orgId]);
      const u = await tx.one<{ whatsapp_opt_in_at: Date | null; whatsapp_consent_version: string | null }>(`select whatsapp_opt_in_at, whatsapp_consent_version from users where id = $1`, [s.userId]);
      const q = await tx.one<{ n: number }>(`select count(*)::int as n from outbound_messages where org_id = $1 and template_key = 'invoice_due_tomorrow' and status = 'queued'`, [s.orgId]);
      return {
        debtorRemindersEnabled: o.debtor_reminders_enabled, defaultLocale: o.default_locale, scheduledInvoiceReminders: q.n,
        whatsappOptIn: !!u.whatsapp_opt_in_at, whatsappConsentVersion: u.whatsapp_consent_version, currentConsentVersion: WHATSAPP_CONSENT.version,
      };
    });
  }

  /** Turning invoice reminders on schedules them for every open credit invoice; turning them off cancels them. */
  @Patch('settings')
  @Roles('owner', 'admin')
  async patchSettings(@CurrentScope() s: OrgScope, @Body(new ZodBody(OrgSettingsBody)) b: z.output<typeof OrgSettingsBody>) {
    if (b.debtorRemindersEnabled === true) await this.features.require(s.orgId, 'invoice_reminders');
    await this.db.run(userCtx(s), async (tx) => {
      await tx.exec(
        `update organisations set debtor_reminders_enabled = coalesce($2, debtor_reminders_enabled), default_locale = coalesce($3, default_locale) where id = $1`,
        [s.orgId, b.debtorRemindersEnabled ?? null, b.defaultLocale ?? null],
      );
      await this.audit.log(tx, 'settings.updated', 'organisation', s.orgId, b);
    });
    const scheduled = b.debtorRemindersEnabled === true ? await this.reminders.scheduleInvoiceReminders(s.orgId) : 0;
    const cancelled = b.debtorRemindersEnabled === false ? await this.reminders.cancelInvoiceReminders(s.orgId) : 0;
    return { ...(await this.settings(s)), scheduled, cancelled };
  }

  @Get('reminders')
  list(@CurrentScope() s: OrgScope, @Query('status') status?: string) {
    return this.reminders.list(s.orgId, status);
  }

  /** The signed-in person's own WhatsApp choice, recorded with the consent wording they accepted. */
  @Post('whatsapp-consent')
  async consent(@CurrentScope() s: OrgScope, @Body(new ZodBody(WhatsAppConsentBody)) b: z.output<typeof WhatsAppConsentBody>) {
    if (b.optIn) {
      await this.features.require(s.orgId, 'whatsapp_opt_in');
      if (b.consentVersion !== WHATSAPP_CONSENT.version) throw conflict('consent_outdated', 'The consent wording changed. Reload and read it again.');
    }
    await this.db.run(userCtx(s), async (tx) => {
      await tx.exec(
        `update users set whatsapp_opt_in_at = case when $2 then coalesce(whatsapp_opt_in_at, now()) else null end,
                whatsapp_consent_version = case when $2 then $3 else whatsapp_consent_version end
         where id = $1`,
        [s.userId, b.optIn, b.consentVersion],
      );
      await this.audit.log(tx, b.optIn ? 'consent.whatsapp_granted' : 'consent.whatsapp_withdrawn', 'user', s.userId, { version: b.consentVersion });
    });
    return { whatsappOptIn: b.optIn };
  }
}
