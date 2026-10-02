import { Injectable } from '@nestjs/common';
import { addDays, addMonths, type IsoDate, monthsElapsed, type VatCode } from '@vat-assist/shared';
import { DomainError, conflict } from '../../common/errors';
import type { Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { OPEN_STATUSES, type PeriodRow, PeriodsService, periodLabel } from '../core/periods.service';
import { RulesService } from '../core/rules.service';
import { assertBalanced, buildPosting, type DraftLine, type PostingLine, reverseLines, type TxnKind } from './posting-rules';

export interface TransactionRow {
  id: string;
  org_id: string;
  kind: TxnKind;
  status: string;
  contact_id: string | null;
  document_id: string | null;
  reference: string | null;
  issue_date: IsoDate;
  delivery_date: IsoDate | null;
  due_date: IsoDate | null;
  settlement: 'cash' | 'credit' | null;
  payment_method: 'cash' | 'bank' | 'juice' | 'card' | 'stripe' | null;
  category: string | null;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  posted_entry_id: string | null;
}

interface LineRow {
  account_id: string | null;
  vat_code: VatCode;
  net_cents: number;
  vat_cents: number;
  payment_method: 'cash' | 'card' | 'juice' | 'credit' | null;
  description: string | null;
}

export interface PostOptions {
  today: IsoDate;
  lateReason?: string;
  treatExpiredClaimAsCost?: boolean;
  reverseChargeInputBlocked?: boolean;
}

export interface PostResult {
  entryId: string;
  entryNo: number;
  periodId: string;
  late: boolean;
  lateReason: string | null;
}

const SALES_KINDS: TxnKind[] = ['sales_invoice', 'sales_credit_note', 'daily_takings', 'deposit'];
const PURCHASE_KINDS: TxnKind[] = ['purchase_invoice', 'purchase_credit_note'];
const isOpen = (p: PeriodRow) => (OPEN_STATUSES as readonly string[]).includes(p.status);

@Injectable()
export class LedgerService {
  constructor(
    private readonly periods: PeriodsService,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  async accountIds(tx: Tx, orgId: string): Promise<Map<string, string>> {
    const rows = await tx.many<{ id: string; system_tag: string }>(
      `select id, system_tag from accounts where org_id = $1 and system_tag is not null`,
      [orgId],
    );
    return new Map(rows.map((r) => [r.system_tag, r.id]));
  }

  /** Writes one immutable, balanced journal entry. The database re-checks balance and period status. */
  async writeEntry(
    tx: Tx,
    a: {
      orgId: string;
      period: PeriodRow;
      entryDate: IsoDate;
      sourceType: 'transaction' | 'reversal' | 'opening' | 'adjustment' | 'vat_settlement';
      transactionId?: string | null;
      description: string;
      reversalOf?: string | null;
      reason?: string | null;
      postedBy: string | null;
      lines: DraftLine[];
    },
  ): Promise<{ id: string; entryNo: number }> {
    assertBalanced(a.lines);
    const ids = await this.accountIds(tx, a.orgId);
    const resolved = a.lines.map((l) => {
      const accountId = 'id' in l.account ? l.account.id : ids.get(l.account.tag);
      if (!accountId) throw new Error(`Account with tag ${'tag' in l.account ? l.account.tag : '?'} is missing`);
      return { ...l, accountId };
    });
    const { n } = await tx.one<{ n: number }>(`select app.next_counter($1, 'journal') as n`, [a.orgId]);
    const entry = await tx.one<{ id: string }>(
      `insert into journal_entries (org_id, entry_no, entry_date, period_id, source_type, transaction_id, description, reversal_of, reason, posted_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [a.orgId, n, a.entryDate, a.period.id, a.sourceType, a.transactionId ?? null, a.description, a.reversalOf ?? null, a.reason ?? null, a.postedBy],
    );
    const values: string[] = [];
    const params: unknown[] = [a.orgId, entry.id];
    resolved.forEach((l, i) => {
      const b = 2 + i * 8;
      values.push(`($1, $2, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
      params.push(i + 1, l.accountId, l.debit, l.credit, l.vatCode ?? null, l.vatRole ?? null, l.contactId ?? null, l.memo ?? null);
    });
    await tx.exec(
      `insert into journal_lines (org_id, entry_id, line_no, account_id, debit_cents, credit_cents, vat_code, vat_role, contact_id, memo)
       values ${values.join(',')}`,
      params,
    );
    return { id: entry.id, entryNo: n };
  }

  /** Time of supply: the issue date, or 3 months after delivery if that comes first (from 1 Oct 2026). */
  private async taxPoint(tx: Tx, t: TransactionRow): Promise<IsoDate> {
    if (!SALES_KINDS.includes(t.kind) || !t.delivery_date) return t.issue_date;
    const deemedOn = addMonths(t.delivery_date, 3);
    const months = await this.rules.backstopMonths(tx, deemedOn);
    if (months == null) return t.issue_date;
    const deemed = addMonths(t.delivery_date, months);
    return deemed < t.issue_date ? deemed : t.issue_date;
  }

  async postTransaction(tx: Tx, actorUserId: string | null, transactionId: string, opts: PostOptions): Promise<PostResult> {
    const t = await tx.one<TransactionRow>(`select * from transactions where id = $1 for update`, [transactionId]);
    if (t.status === 'posted' || t.status === 'void') throw conflict('already_posted', `This ${t.kind.replace('_', ' ')} is already ${t.status}.`);
    const org = await tx.one<{ start_date: IsoDate }>(`select start_date from organisations where id = $1`, [t.org_id]);
    let lines = await tx.many<LineRow>(
      `select account_id, vat_code, net_cents, vat_cents, payment_method, description from lines where transaction_id = $1 order by line_no`,
      [t.id],
    );
    if (!lines.length && !['receipt', 'payment'].includes(t.kind)) throw new DomainError('no_lines', 'Nothing to post: the transaction has no lines.');

    // 1. Which VAT period does it belong to, and is that period still open?
    let taxPoint = await this.taxPoint(tx, t);
    let natural: PeriodRow;
    let late = false;
    let lateReason: string | null = null;
    if (taxPoint < org.start_date) {
      if (!opts.lateReason) {
        throw conflict('before_books_start', `This document is dated ${taxPoint}, before your books start (${org.start_date}). Your accountant will decide how to treat it.`);
      }
      taxPoint = org.start_date;
      late = true;
      lateReason = opts.lateReason;
    }
    natural = await this.periods.ensure(tx, t.org_id, taxPoint);
    let target = natural;
    if (!isOpen(natural)) {
      target = await this.periods.firstOpenFrom(tx, t.org_id, addDays(natural.ends_on, 1));
      late = true;
      lateReason = opts.lateReason ?? `Recorded after ${periodLabel(natural)} was ${natural.status.replace('_', ' ')}`;
    }

    // 2. Late purchases: input VAT may only be claimed within the window in force at the time of claiming.
    if (PURCHASE_KINDS.includes(t.kind) && lines.some((l) => l.vat_code === 'SR' && l.vat_cents !== 0)) {
      const windowMonths = await this.rules.claimWindowMonths(tx, opts.today);
      const elapsed = monthsElapsed(natural.ends_on, target.ends_on);
      if (elapsed > windowMonths) {
        if (!opts.treatExpiredClaimAsCost) {
          throw conflict(
            'claim_window_expired',
            `Input VAT on this invoice belongs to ${periodLabel(natural)}, more than ${windowMonths} months before ${periodLabel(target)}. It can no longer be claimed.`,
          );
        }
        lines = lines.map((l) => (l.vat_code === 'SR' ? { ...l, vat_code: 'NC' } : l));
      }
    }

    const rateBp = await this.rules.standardRateBp(tx, taxPoint);
    const postingLines: PostingLine[] = lines.map((l) => ({
      accountId: l.account_id,
      vatCode: l.vat_code,
      netCents: l.net_cents,
      vatCents: l.vat_cents,
      paymentMethod: l.payment_method,
      description: l.description,
    }));
    const draft = buildPosting({
      kind: t.kind,
      settlement: t.settlement,
      paymentMethod: t.payment_method,
      contactId: t.contact_id,
      grossCents: t.gross_cents,
      lines: postingLines,
      standardRateBp: rateBp,
      reverseChargeInputBlocked: opts.reverseChargeInputBlocked,
    });

    const entryDate = late ? target.starts_on : taxPoint;
    const entry = await this.writeEntry(tx, {
      orgId: t.org_id,
      period: target,
      entryDate,
      sourceType: 'transaction',
      transactionId: t.id,
      description: `${t.kind.replace(/_/g, ' ')}${t.reference ? ` ${t.reference}` : ''}`,
      postedBy: actorUserId,
      lines: draft,
    });
    await tx.exec(
      `update transactions set status = 'posted', period_id = $2, original_period_id = $3, is_late = $4, late_reason = $5,
              posted_entry_id = $6, posted_at = now() where id = $1`,
      [t.id, target.id, late ? natural.id : null, late, lateReason, entry.id],
    );
    await this.audit.log(tx, 'transaction.posted', 'transaction', t.id, {
      kind: t.kind,
      entryNo: entry.entryNo,
      period: periodLabel(target),
      grossCents: t.gross_cents,
      late,
    });

    if (late && SALES_KINDS.includes(t.kind)) {
      await this.raiseSystemQuery(
        tx,
        t.org_id,
        target.id,
        t.id,
        `This sale belongs to ${periodLabel(natural)}, which was already ${natural.status.replace('_', ' ')}. ` +
          `Its output VAT was not in that return. Decide whether to correct the ${periodLabel(natural)} return with MRA or declare it now.`,
      );
    }
    return { entryId: entry.id, entryNo: entry.entryNo, periodId: target.id, late, lateReason };
  }

  async raiseSystemQuery(tx: Tx, orgId: string, periodId: string | null, transactionId: string | null, body: string): Promise<string> {
    const q = await tx.one<{ id: string }>(
      `insert into queries (org_id, period_id, transaction_id, blocking, raised_by) values ($1, $2, $3, true, null) returning id`,
      [orgId, periodId, transactionId],
    );
    await tx.exec(`insert into query_messages (org_id, query_id, author_id, body) values ($1, $2, null, $3)`, [orgId, q.id, body]);
    await this.audit.log(tx, 'query.raised', 'query', q.id, { automatic: true, transactionId });
    return q.id;
  }

  /** A reversal mirrors the original entry. It lands in the original period if still open, else the next open one. */
  async reverseEntry(tx: Tx, actorUserId: string | null, entryId: string, reason: string, today: IsoDate): Promise<{ id: string; entryNo: number }> {
    const e = await tx.one<{ id: string; org_id: string; period_id: string; entry_date: IsoDate; transaction_id: string | null; description: string }>(
      `select id, org_id, period_id, entry_date, transaction_id, description from journal_entries where id = $1`,
      [entryId],
    );
    if (await tx.maybe(`select 1 from journal_entries where reversal_of = $1`, [entryId])) {
      throw conflict('already_reversed', 'This entry has already been reversed.');
    }
    const lines = await tx.many<{ account_id: string; debit_cents: number; credit_cents: number; vat_code: VatCode | null; vat_role: 'base' | 'tax' | null; contact_id: string | null; memo: string | null }>(
      `select account_id, debit_cents, credit_cents, vat_code, vat_role, contact_id, memo from journal_lines where entry_id = $1 order by line_no`,
      [entryId],
    );
    const original = await this.periods.byId(tx, e.period_id);
    const target = isOpen(original) ? original : await this.periods.firstOpenFrom(tx, e.org_id, addDays(original.ends_on, 1));
    const entryDate = target.id === original.id ? e.entry_date : today < target.starts_on ? target.starts_on : today > target.ends_on ? target.ends_on : today;
    const draft: DraftLine[] = reverseLines(
      lines.map((l) => ({
        account: { id: l.account_id },
        debit: l.debit_cents,
        credit: l.credit_cents,
        vatCode: l.vat_code ?? undefined,
        vatRole: l.vat_role ?? undefined,
        contactId: l.contact_id,
        memo: l.memo ?? undefined,
      })),
    );
    const out = await this.writeEntry(tx, {
      orgId: e.org_id,
      period: target,
      entryDate,
      sourceType: 'reversal',
      transactionId: e.transaction_id,
      description: `Reversal of: ${e.description}`,
      reversalOf: e.id,
      reason,
      postedBy: actorUserId,
      lines: draft,
    });
    await this.audit.log(tx, 'journal.reversed', 'journal_entry', e.id, { reversalEntryNo: out.entryNo, reason, period: periodLabel(target) });
    return out;
  }

  /** Void = reverse the posting, unwind any allocations this payment made, mark the transaction void. */
  async voidTransaction(tx: Tx, actorUserId: string | null, transactionId: string, reason: string, today: IsoDate): Promise<void> {
    const t = await tx.one<TransactionRow>(`select * from transactions where id = $1 for update`, [transactionId]);
    if (t.status !== 'posted' || !t.posted_entry_id) throw conflict('not_posted', 'Only posted transactions can be voided.');
    const paidAgainst = await tx.one<{ s: number }>(
      `select coalesce(sum(amount_cents), 0)::bigint as s from allocations where invoice_transaction_id = $1`,
      [t.id],
    );
    if (paidAgainst.s !== 0) throw conflict('has_payments', 'Payments are recorded against this invoice. Void those payments first.');
    const made = await tx.many<{ invoice_transaction_id: string; s: number }>(
      `select invoice_transaction_id, sum(amount_cents)::bigint as s from allocations where payment_transaction_id = $1 group by 1 having sum(amount_cents) <> 0`,
      [t.id],
    );
    for (const a of made) {
      await tx.exec(
        `insert into allocations (org_id, payment_transaction_id, invoice_transaction_id, amount_cents, allocated_on) values ($1, $2, $3, $4, $5)`,
        [t.org_id, t.id, a.invoice_transaction_id, -a.s, today],
      );
    }
    await this.reverseEntry(tx, actorUserId, t.posted_entry_id, reason, today);
    await tx.exec(`update transactions set status = 'void', void_reason = $2 where id = $1`, [t.id, reason]);
    await this.audit.log(tx, 'transaction.voided', 'transaction', t.id, { reason });
  }
}
