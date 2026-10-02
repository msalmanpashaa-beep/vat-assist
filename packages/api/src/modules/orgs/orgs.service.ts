import { Injectable } from '@nestjs/common';
import { CreateOrgBody, OpeningBalancesBody } from '@vat-assist/shared';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { z } from 'zod';
import type { Actor, OrgScope } from '../../common/auth-context';
import { DomainError, conflict } from '../../common/errors';
import { Db, type Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { PeriodsService } from '../core/periods.service';
import { installChart } from '../ledger/chart';
import { findOrCreateContact } from '../ledger/contacts';
import { LedgerService } from '../ledger/ledger.service';
import type { DraftLine } from '../ledger/posting-rules';

@Injectable()
export class OrgsService {
  constructor(
    private readonly db: Db,
    private readonly periods: PeriodsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /** Onboarding step 1: the business, its chart of accounts and its first VAT period. */
  async create(actor: Actor, body: z.output<typeof CreateOrgBody>) {
    return this.db.run({ kind: 'user', userId: actor.userId }, async (tx) => {
      const { id } = await tx.one<{ id: string }>(`select app.create_org_with_owner($1::jsonb) as id`, [JSON.stringify(body)]);
      await tx.pinOrg(id);
      await installChart(tx, id);
      const period = await this.periods.ensure(tx, id, body.startDate);
      await this.audit.log(tx, 'org.created', 'organisation', id, {
        legalName: body.legalName,
        filingFrequency: body.filingFrequency,
        startDate: body.startDate,
      });
      return { orgId: id, firstPeriodId: period.id, dueStandard: period.due_on, dueElectronic: period.extended_due_on };
    });
  }

  async get(tx: Tx, orgId: string) {
    return tx.one(
      `select id, legal_name, trading_name, legal_form, brn, vat_number, vat_registered_on, filing_frequency,
              files_and_pays_electronically, start_date, shop_type, default_locale, is_platform, debtor_reminders_enabled,
              opening_vat_credit_cents, created_at
       from organisations where id = $1`,
      [orgId],
    );
  }

  /**
   * Onboarding step 2: what the business already has and owes on its start date. Debts per customer and
   * supplier become open items so they show up in ageing from day one.
   */
  async openingBalances(s: OrgScope, body: z.output<typeof OpeningBalancesBody>) {
    return this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      if (await tx.maybe(`select 1 from journal_entries where org_id = $1 and source_type = 'opening' limit 1`, [s.orgId])) {
        throw conflict('opening_exists', 'Opening balances are already recorded. Ask your reviewer to adjust them.');
      }
      const org = await tx.one<{ start_date: string }>(`select start_date from organisations where id = $1`, [s.orgId]);
      const period = await this.periods.ensure(tx, s.orgId, org.start_date);
      if (!['open', 'in_review'].includes(period.status)) throw conflict('period_locked', 'The first VAT period is already locked.');

      const lines: DraftLine[] = [];
      const add = (tag: string, amount: number, memo: string) => {
        if (amount > 0) lines.push({ account: { tag }, debit: amount, credit: 0, memo });
        if (amount < 0) lines.push({ account: { tag }, debit: 0, credit: -amount, memo });
      };
      add('cash', body.cashInHandCents, 'Cash in hand');
      const bank = body.bankBalances.reduce((t, b) => t + b.amountCents, 0);
      add('bank', bank, body.bankBalances.map((b) => b.name).join(', ') || 'Bank');
      add('stock', body.stockCents, 'Stock');
      add('vat_payable', body.vatCreditCarriedForwardCents, 'VAT credit carried forward from last return');
      add('vat_payable', -body.vatPayableUnpaidCents, 'VAT from last return not yet paid');
      const net = lines.reduce((t, l) => t + l.debit - l.credit, 0);
      if (net !== 0) lines.push({ account: { tag: 'opening_equity' }, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0, memo: 'Opening balance' });
      let entryNo: number | null = null;
      if (lines.length >= 2) {
        entryNo = (await this.ledger.writeEntry(tx, {
          orgId: s.orgId, period, entryDate: org.start_date, sourceType: 'opening',
          description: 'Opening balances', postedBy: s.userId, lines,
        })).entryNo;
      }
      await tx.exec(`update organisations set opening_vat_credit_cents = $2 where id = $1`, [s.orgId, body.vatCreditCarriedForwardCents]);

      const items = [
        ...body.customersOwe.map((c) => ({ ...c, side: 'receivable' as const })),
        ...body.suppliersOwed.map((c) => ({ ...c, side: 'payable' as const })),
      ];
      for (const item of items) {
        const phone = item.phone ? parsePhoneNumberFromString(item.phone, 'MU')?.number ?? null : null;
        const contact = await findOrCreateContact(tx, s.orgId, { name: item.name, kind: item.side === 'receivable' ? 'customer' : 'supplier', phone });
        const t = await tx.one<{ id: string }>(
          `insert into transactions (org_id, kind, contact_id, reference, issue_date, due_date, settlement, open_item_side, net_cents, vat_cents, gross_cents, created_by)
           values ($1, 'opening_balance', $2, 'Opening', $3, $4, 'credit', $5, $6, 0, $6, $7) returning id`,
          [s.orgId, contact.id, item.date ?? org.start_date, item.dueDate ?? null, item.side, item.amountCents, s.userId],
        );
        const ctrl = item.side === 'receivable' ? 'debtors' : 'creditors';
        const e = await this.ledger.writeEntry(tx, {
          orgId: s.orgId, period, entryDate: org.start_date, sourceType: 'opening', transactionId: t.id,
          description: `Opening balance: ${item.name}`, postedBy: s.userId,
          lines: item.side === 'receivable'
            ? [{ account: { tag: ctrl }, debit: item.amountCents, credit: 0, contactId: contact.id }, { account: { tag: 'opening_equity' }, debit: 0, credit: item.amountCents }]
            : [{ account: { tag: 'opening_equity' }, debit: item.amountCents, credit: 0 }, { account: { tag: ctrl }, debit: 0, credit: item.amountCents, contactId: contact.id }],
        });
        await tx.exec(`update transactions set status = 'posted', period_id = $2, posted_entry_id = $3, posted_at = now() where id = $1`, [t.id, period.id, e.id]);
      }
      await this.audit.log(tx, 'org.opening_balances', 'organisation', s.orgId, { entryNo, openItems: items.length });
      return { entryNo, openItems: items.length };
    });
  }

  async members(tx: Tx, orgId: string) {
    return tx.many(
      `select m.id, m.role, m.created_at, u.id as user_id, u.full_name, u.phone_e164, u.email
       from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.revoked_at is null order by m.role, u.full_name`,
      [orgId],
    );
  }

  async inviteStaff(s: OrgScope, rawPhone: string, name: string | undefined, locale: string | undefined) {
    const p = parsePhoneNumberFromString(rawPhone, 'MU');
    if (!p?.isValid()) throw new DomainError('invalid_phone', 'Enter a valid mobile number.', 400);
    return this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      const { id } = await tx.one<{ id: string }>(`select app.invite_shop_staff($1, $2, $3, $4) as id`, [s.orgId, p.number, name ?? null, locale ?? null]);
      await this.audit.log(tx, 'member.invited', 'user', id, { role: 'staff' });
      return { userId: id };
    });
  }
}
