import { Injectable } from '@nestjs/common';
import {
  addDays, ageOpenItems, type AgeingBasis, type AgeingReport, DailyTakingsBody, type IsoDate, PaymentBody,
  SalesInvoiceBody, splitGross, todayIn, vatFromNet,
} from '@vat-assist/shared';
import type { z } from 'zod';
import { AppConfig } from '../../config';
import { DomainError, conflict, notFound } from '../../common/errors';
import type { Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { RulesService } from '../core/rules.service';
import { findOrCreateContact } from './contacts';
import { LedgerService, type PostResult } from './ledger.service';

export type PaymentRecord = Omit<z.output<typeof PaymentBody>, 'method'> & { method: 'cash' | 'bank' | 'juice' | 'card' | 'stripe' | 'mips' };

@Injectable()
export class TransactionsService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly ledger: LedgerService,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  today(): IsoDate {
    return todayIn(this.cfg.env.TZ_BUSINESS);
  }

  /** End-of-day takings, VAT-inclusive, split by how customers paid and by VAT rate. */
  async dailyTakings(tx: Tx, userId: string, orgId: string, body: z.output<typeof DailyTakingsBody>): Promise<{ transactionId: string; posting: PostResult }> {
    const rate = await this.rules.standardRateBp(tx, body.date);
    const lines = body.lines.map((l) => {
      const { net, vat } = l.vatCode === 'SR' ? splitGross(l.grossCents, rate) : { net: l.grossCents, vat: 0 };
      return { ...l, net, vat };
    });
    const net = lines.reduce((s, l) => s + l.net, 0);
    const vat = lines.reduce((s, l) => s + l.vat, 0);
    const t = await tx.one<{ id: string }>(
      `insert into transactions (org_id, kind, issue_date, settlement, document_id, net_cents, vat_cents, gross_cents, created_by, reference)
       values ($1, 'daily_takings', $2, 'cash', $3, $4, $5, $6, $7, $8) returning id`,
      [orgId, body.date, body.documentId ?? null, net, vat, net + vat, userId, `Takings ${body.date}`],
    );
    let i = 0;
    for (const l of lines) {
      await tx.exec(
        `insert into lines (org_id, transaction_id, line_no, vat_code, payment_method, net_cents, vat_cents, description) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orgId, t.id, ++i, l.vatCode, l.method, l.net, l.vat, `${l.method} takings`],
      );
    }
    const posting = await this.ledger.postTransaction(tx, userId, t.id, { today: this.today() });
    return { transactionId: t.id, posting };
  }

  async salesInvoice(tx: Tx, userId: string, orgId: string, body: z.output<typeof SalesInvoiceBody>) {
    let contactId: string;
    let terms: number | null = null;
    if (body.customerId) {
      const c = await tx.maybe<{ id: string; payment_terms_days: number | null }>(`select id, payment_terms_days from contacts where id = $1 and org_id = $2`, [body.customerId, orgId]);
      if (!c) throw notFound('Customer');
      contactId = c.id;
      terms = c.payment_terms_days;
    } else if (body.customerName) {
      const c = await findOrCreateContact(tx, orgId, { name: body.customerName, kind: 'customer', phone: body.customerPhone ?? null });
      contactId = c.id;
      terms = c.payment_terms_days;
    } else {
      throw new DomainError('customer_required', 'Choose a customer or type their name.', 400);
    }
    if (body.customerPhone || body.customerReminderConsent !== undefined) {
      await tx.exec(
        `update contacts set phone_e164 = coalesce($3, phone_e164),
                reminder_consent_at = case when $4::boolean is true then coalesce(reminder_consent_at, now())
                                           when $4::boolean is false then null else reminder_consent_at end
         where id = $1 and org_id = $2`,
        [contactId, orgId, body.customerPhone ?? null, body.customerReminderConsent ?? null],
      );
    }
    const rate = await this.rules.standardRateBp(tx, body.issueDate);
    const lines = body.lines.map((l) => ({ ...l, vat: l.vatCode === 'SR' ? vatFromNet(l.netCents, rate) : 0 }));
    const net = lines.reduce((s, l) => s + l.netCents, 0);
    const vat = lines.reduce((s, l) => s + l.vat, 0);
    const { n } = await tx.one<{ n: number }>(`select app.next_counter($1, 'sales_invoice') as n`, [orgId]);
    const reference = `INV-${String(n).padStart(5, '0')}`;
    const credit = body.settlement.mode === 'credit';
    const dueDate = body.settlement.mode === 'credit' ? (body.settlement.dueDate ?? addDays(body.issueDate, terms ?? 30)) : null;
    const t = await tx.one<{ id: string }>(
      `insert into transactions (org_id, kind, contact_id, reference, issue_date, delivery_date, due_date, settlement, payment_method,
                                 open_item_side, net_cents, vat_cents, gross_cents, created_by)
       values ($1, 'sales_invoice', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [orgId, contactId, reference, body.issueDate, body.deliveryDate ?? null, dueDate, body.settlement.mode,
        body.settlement.mode === 'cash' ? body.settlement.method : null, credit ? 'receivable' : null, net, vat, net + vat, userId],
    );
    let i = 0;
    for (const l of lines) {
      await tx.exec(
        `insert into lines (org_id, transaction_id, line_no, description, quantity, vat_code, net_cents, vat_cents) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orgId, t.id, ++i, l.description, l.quantity ?? null, l.vatCode, l.netCents, l.vat],
      );
    }
    const posting = await this.ledger.postTransaction(tx, userId, t.id, { today: this.today() });
    return { transactionId: t.id, reference, grossCents: net + vat, dueDate, posting };
  }

  /** Receipts and payments, matched to open invoices. Unmatched money stays on the contact's account. */
  async recordPayment(tx: Tx, userId: string | null, orgId: string, body: PaymentRecord): Promise<{ transactionId: string; unallocatedCents: number }> {
    const contact = await tx.maybe(`select id from contacts where id = $1 and org_id = $2`, [body.contactId, orgId]);
    if (!contact) throw notFound('Contact');
    const side = body.kind === 'receipt' ? 'receivable' : 'payable';
    let allocated = 0;
    for (const a of body.allocations) {
      const inv = await tx.maybe<{ id: string; contact_id: string; open_item_side: string; status: string; settlement: string; gross_cents: number }>(
        `select id, contact_id, open_item_side, status, settlement, gross_cents from transactions where id = $1 and org_id = $2 for update`,
        [a.invoiceId, orgId],
      );
      if (!inv || inv.status !== 'posted' || inv.settlement !== 'credit') throw notFound('Open invoice');
      if (inv.open_item_side !== side) throw new DomainError('wrong_side', `That invoice is not a ${side}.`, 400);
      if (inv.contact_id !== body.contactId) throw new DomainError('wrong_contact', 'That invoice belongs to a different contact.', 400);
      const { outstanding } = await tx.one<{ outstanding: number }>(
        `select $2::bigint - coalesce(sum(amount_cents), 0)::bigint as outstanding from allocations where invoice_transaction_id = $1`,
        [inv.id, inv.gross_cents],
      );
      if (a.amountCents > outstanding) throw conflict('over_allocation', `Only ${outstanding / 100} is still owed on that invoice.`);
      allocated += a.amountCents;
    }
    if (allocated > body.amountCents) throw new DomainError('over_allocation', 'Allocations add up to more than the payment.', 400);
    const t = await tx.one<{ id: string }>(
      `insert into transactions (org_id, kind, contact_id, issue_date, settlement, payment_method, net_cents, vat_cents, gross_cents, created_by)
       values ($1, $2, $3, $4, 'cash', $5, $6, 0, $6, $7) returning id`,
      [orgId, body.kind, body.contactId, body.date, body.method, body.amountCents, userId],
    );
    await this.ledger.postTransaction(tx, userId, t.id, { today: this.today() });
    for (const a of body.allocations) {
      await tx.exec(
        `insert into allocations (org_id, payment_transaction_id, invoice_transaction_id, amount_cents, allocated_on) values ($1, $2, $3, $4, $5)`,
        [orgId, t.id, a.invoiceId, a.amountCents, body.date],
      );
    }
    await this.audit.log(tx, 'payment.recorded', 'transaction', t.id, { kind: body.kind, amountCents: body.amountCents, method: body.method, allocatedCents: allocated });
    return { transactionId: t.id, unallocatedCents: body.amountCents - allocated };
  }

  async ageing(tx: Tx, orgId: string, side: 'receivable' | 'payable', asOf: IsoDate, basis: AgeingBasis): Promise<AgeingReport> {
    const rows = await tx.many<{ transaction_id: string; contact_id: string | null; contact_name: string | null; reference: string | null; issue_date: IsoDate; due_date: IsoDate | null; outstanding_cents: number }>(
      `select transaction_id, contact_id, contact_name, reference, issue_date, due_date, outstanding_cents
       from v_open_items where org_id = $1 and side = $2 and outstanding_cents <> 0 and issue_date <= $3`,
      [orgId, side, asOf],
    );
    return ageOpenItems(
      rows.map((r) => ({
        transactionId: r.transaction_id,
        contactId: r.contact_id,
        contactName: r.contact_name,
        reference: r.reference,
        issueDate: r.issue_date,
        dueDate: r.due_date,
        outstandingCents: r.outstanding_cents,
      })),
      asOf,
      basis,
    );
  }

  async list(tx: Tx, orgId: string, f: { status?: string; kind?: string; limit?: number }) {
    return tx.many(
      `select t.id, t.kind, t.status, t.reference, t.issue_date, t.due_date, t.settlement, t.payment_method, t.net_cents, t.vat_cents,
              t.gross_cents, t.is_late, t.late_reason, t.document_id, c.name as contact_name, p.starts_on as period_start
       from transactions t left join contacts c on c.id = t.contact_id left join vat_periods p on p.id = t.period_id
       where t.org_id = $1 and ($2::text is null or t.status = $2) and ($3::text is null or t.kind = $3)
       order by t.issue_date desc, t.created_at desc limit $4`,
      [orgId, f.status ?? null, f.kind ?? null, Math.min(f.limit ?? 100, 500)],
    );
  }
}
