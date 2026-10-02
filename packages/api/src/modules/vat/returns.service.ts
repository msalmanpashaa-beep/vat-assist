import { Injectable } from '@nestjs/common';
import type { ReturnFigures } from '@vat-assist/shared';
import type { OrgScope } from '../../common/auth-context';
import { canonicalJson, sha256Hex } from '../../common/crypto';
import { conflict, notFound } from '../../common/errors';
import type { Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { type PeriodRow, periodLabel } from '../core/periods.service';
import { VatPotService } from './vat-pot.service';

interface LineRow {
  debit_cents: number;
  credit_cents: number;
  vat_code: string;
  vat_role: 'base' | 'tax';
  system_tag: string | null;
  account_type: string;
  txn_id: string | null;
  kind: string | null;
  is_late: boolean | null;
}

export interface Supporting {
  inputVatInvoices: Array<{ date: string; supplier: string | null; supplierVat: string | null; reference: string | null; netCents: number; vatCents: number; late: boolean }>;
  salesInvoices: Array<{ date: string; customer: string | null; reference: string | null; netCents: number; vatCents: number; late: boolean }>;
  lateItems: Array<{ kind: string; reference: string | null; date: string; reason: string | null }>;
  reversals: Array<{ entryNo: number; description: string; reason: string | null }>;
  entryCount: number;
}

export interface ReturnRow {
  id: string;
  org_id: string;
  period_id: string;
  version: number;
  status: 'draft' | 'superseded' | 'signed_off' | 'filed' | 'paid';
  figures: ReturnFigures;
  supporting: Supporting;
  fingerprint: string;
  prepared_by: string | null;
  prepared_at: Date;
  signed_off_by: string | null;
  signed_off_at: Date | null;
  mra_reference: string | null;
  acknowledgement_document_id: string | null;
  filed_at: Date | null;
  payment_reference: string | null;
  paid_on: string | null;
}

const SALES_KINDS = ['sales_invoice', 'sales_credit_note', 'daily_takings', 'deposit'];
const PURCHASE_KINDS = ['purchase_invoice', 'purchase_credit_note'];

/**
 * Builds the VAT return straight from the ledger (never from editable totals), versions each draft,
 * and signs off with a SHA-256 fingerprint of the figures and the exact journal entries behind them.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly pot: VatPotService,
    private readonly audit: AuditService,
  ) {}

  async build(tx: Tx, period: PeriodRow): Promise<{ figures: ReturnFigures; supporting: Supporting; fingerprint: string }> {
    const rows = await tx.many<LineRow>(
      `select jl.debit_cents, jl.credit_cents, jl.vat_code, jl.vat_role, a.system_tag, a.type as account_type,
              t.id as txn_id, t.kind, t.is_late
       from journal_lines jl
       join journal_entries je on je.id = jl.entry_id
       join accounts a on a.id = jl.account_id
       left join transactions t on t.id = je.transaction_id
       where je.period_id = $1 and je.source_type <> 'vat_settlement' and jl.vat_role is not null`,
      [period.id],
    );
    const f: ReturnFigures = {
      periodStart: period.starts_on,
      periodEnd: period.ends_on,
      sales: { standardRatedNet: 0, zeroRatedNet: 0, exemptNet: 0, outOfScopeNet: 0 },
      outputVat: { onSales: 0, reverseCharge: 0, total: 0 },
      purchases: { standardRatedNet: 0, zeroRatedNet: 0, exemptNet: 0, blockedOrNotClaimableGross: 0, reverseChargeNet: 0 },
      inputVat: { local: 0, lateClaims: 0, reverseCharge: 0, total: 0 },
      creditBroughtForward: 0,
      netPayable: 0,
      creditCarriedForward: 0,
      counts: { salesDocs: 0, purchaseDocs: 0, lateDocs: 0, openBlockingQueries: 0 },
    };
    const salesDocs = new Set<string>();
    const purchaseDocs = new Set<string>();
    const lateDocs = new Set<string>();
    for (const r of rows) {
      if (r.txn_id && r.kind) {
        if (SALES_KINDS.includes(r.kind)) salesDocs.add(r.txn_id);
        if (PURCHASE_KINDS.includes(r.kind)) purchaseDocs.add(r.txn_id);
        if (r.is_late) lateDocs.add(r.txn_id);
      }
      if (r.vat_role === 'tax') {
        if (r.system_tag === 'output_vat') {
          const amt = r.credit_cents - r.debit_cents;
          if (r.vat_code === 'RC') f.outputVat.reverseCharge += amt;
          else f.outputVat.onSales += amt;
        } else if (r.system_tag === 'input_vat') {
          const amt = r.debit_cents - r.credit_cents;
          if (r.vat_code === 'RC') f.inputVat.reverseCharge += amt;
          else if (r.is_late) f.inputVat.lateClaims += amt;
          else f.inputVat.local += amt;
        }
        continue;
      }
      const salesSide = r.account_type === 'income' || r.system_tag === 'customer_deposits';
      if (salesSide) {
        const amt = r.credit_cents - r.debit_cents;
        if (r.vat_code === 'SR') f.sales.standardRatedNet += amt;
        else if (r.vat_code === 'ZR') f.sales.zeroRatedNet += amt;
        else if (r.vat_code === 'EX') f.sales.exemptNet += amt;
        else f.sales.outOfScopeNet += amt;
      } else {
        const amt = r.debit_cents - r.credit_cents;
        if (r.vat_code === 'SR') f.purchases.standardRatedNet += amt;
        else if (r.vat_code === 'ZR') f.purchases.zeroRatedNet += amt;
        else if (r.vat_code === 'EX') f.purchases.exemptNet += amt;
        else if (r.vat_code === 'RC') f.purchases.reverseChargeNet += amt;
        else if (r.vat_code === 'BL' || r.vat_code === 'NC') f.purchases.blockedOrNotClaimableGross += amt;
      }
    }
    f.outputVat.total = f.outputVat.onSales + f.outputVat.reverseCharge;
    f.inputVat.total = f.inputVat.local + f.inputVat.lateClaims + f.inputVat.reverseCharge;
    f.creditBroughtForward = await this.pot.creditBroughtForward(tx, period);
    const net = f.outputVat.total - f.inputVat.total - f.creditBroughtForward;
    f.netPayable = Math.max(0, net);
    f.creditCarriedForward = Math.max(0, -net);
    f.counts = {
      salesDocs: salesDocs.size,
      purchaseDocs: purchaseDocs.size,
      lateDocs: lateDocs.size,
      openBlockingQueries: await this.openBlockingQueries(tx, period),
    };

    const entries = await tx.many<{ id: string; entry_no: number }>(
      `select id, entry_no from journal_entries where period_id = $1 and source_type <> 'vat_settlement' order by entry_no`,
      [period.id],
    );
    const supporting: Supporting = {
      inputVatInvoices: (
        await tx.many<{ issue_date: string; name: string | null; vat_number: string | null; reference: string | null; net_cents: number; vat_cents: number; is_late: boolean }>(
          // Built from the input-VAT ledger lines, so the schedule always adds up to the claimed total.
          `select t.issue_date, c.name, c.vat_number, t.reference, t.net_cents,
                  sum(jl.debit_cents - jl.credit_cents)::bigint as vat_cents, t.is_late
           from journal_lines jl
           join journal_entries je on je.id = jl.entry_id
           join accounts a on a.id = jl.account_id and a.system_tag = 'input_vat'
           join transactions t on t.id = je.transaction_id
           left join contacts c on c.id = t.contact_id
           where je.period_id = $1 and je.source_type <> 'vat_settlement'
           group by t.id, t.issue_date, c.name, c.vat_number, t.reference, t.net_cents, t.is_late
           having sum(jl.debit_cents - jl.credit_cents) <> 0
           order by t.issue_date, t.reference`,
          [period.id],
        )
      ).map((r) => ({ date: r.issue_date, supplier: r.name, supplierVat: r.vat_number, reference: r.reference, netCents: r.net_cents, vatCents: r.vat_cents, late: r.is_late })),
      salesInvoices: (
        await tx.many<{ issue_date: string; name: string | null; reference: string | null; net_cents: number; vat_cents: number; is_late: boolean }>(
          `select t.issue_date, c.name, t.reference, t.net_cents, t.vat_cents, t.is_late
           from transactions t left join contacts c on c.id = t.contact_id
           where t.period_id = $1 and t.kind in ('sales_invoice', 'sales_credit_note') and t.status = 'posted'
           order by t.issue_date, t.reference`,
          [period.id],
        )
      ).map((r) => ({ date: r.issue_date, customer: r.name, reference: r.reference, netCents: r.net_cents, vatCents: r.vat_cents, late: r.is_late })),
      lateItems: (
        await tx.many<{ kind: string; reference: string | null; issue_date: string; late_reason: string | null }>(
          `select kind, reference, issue_date, late_reason from transactions where period_id = $1 and is_late and status = 'posted' order by issue_date`,
          [period.id],
        )
      ).map((r) => ({ kind: r.kind, reference: r.reference, date: r.issue_date, reason: r.late_reason })),
      reversals: (
        await tx.many<{ entry_no: number; description: string; reason: string | null }>(
          `select entry_no, description, reason from journal_entries where period_id = $1 and source_type = 'reversal' order by entry_no`,
          [period.id],
        )
      ).map((r) => ({ entryNo: r.entry_no, description: r.description, reason: r.reason })),
      entryCount: entries.length,
    };
    // Open queries change while a draft waits for sign-off; they are excluded from the fingerprint.
    const fingerprint = sha256Hex(
      canonicalJson({
        orgId: period.org_id,
        periodId: period.id,
        figures: { ...f, counts: { ...f.counts, openBlockingQueries: undefined } },
        entries: entries.map((e) => `${e.entry_no}:${e.id}`),
      }),
    );
    return { figures: f, supporting, fingerprint };
  }

  async openBlockingQueries(tx: Tx, period: PeriodRow): Promise<number> {
    const r = await tx.one<{ n: number }>(
      `select count(*)::int as n from queries
       where org_id = $1 and blocking and status in ('open', 'answered') and (period_id = $2 or period_id is null)`,
      [period.org_id, period.id],
    );
    return r.n;
  }

  async draft(tx: Tx, s: OrgScope, periodId: string) {
    const period = await tx.maybe<PeriodRow>(`select * from vat_periods where id = $1 and org_id = $2 for update`, [periodId, s.orgId]);
    if (!period) throw notFound('VAT period');
    if (!['open', 'in_review'].includes(period.status)) {
      throw conflict('period_locked', `${periodLabel(period)} is already ${period.status.replace('_', ' ')}.`);
    }
    if (period.status === 'open') await tx.exec(`update vat_periods set status = 'in_review' where id = $1`, [period.id]);
    const built = await this.build(tx, period);
    const { v } = await tx.one<{ v: number }>(`select coalesce(max(version), 0) + 1 as v from vat_returns where period_id = $1`, [period.id]);
    await tx.exec(`update vat_returns set status = 'superseded' where period_id = $1 and status = 'draft'`, [period.id]);
    const r = await tx.one<{ id: string }>(
      `insert into vat_returns (org_id, period_id, version, status, figures, supporting, fingerprint, prepared_by)
       values ($1, $2, $3, 'draft', $4, $5, $6, $7) returning id`,
      [s.orgId, period.id, v, JSON.stringify(built.figures), JSON.stringify(built.supporting), built.fingerprint, s.userId],
    );
    await this.audit.log(tx, 'return.drafted', 'vat_return', r.id, {
      period: periodLabel(period),
      version: v,
      netPayableCents: built.figures.netPayable,
      creditCarriedForwardCents: built.figures.creditCarriedForward,
      fingerprint: built.fingerprint,
    });
    return { returnId: r.id, version: v, periodLabel: periodLabel(period), figures: built.figures, fingerprint: built.fingerprint };
  }

  /** Senior reviewer sign-off: re-derive the figures, compare fingerprints, then lock the period. */
  async signOff(tx: Tx, s: OrgScope, returnId: string) {
    const r = await tx.maybe<ReturnRow>(`select * from vat_returns where id = $1 and org_id = $2 for update`, [returnId, s.orgId]);
    if (!r) throw notFound('VAT return');
    if (r.status !== 'draft') throw conflict('not_draft', `This return is ${r.status.replace('_', ' ')}, not a draft.`);
    const latest = await tx.one<{ v: number }>(`select max(version) as v from vat_returns where period_id = $1`, [r.period_id]);
    if (latest.v !== r.version) throw conflict('stale_draft', 'A newer draft exists for this period. Sign that one off instead.');
    // FOR UPDATE waits for any posting in progress (postings take FOR SHARE on the period row).
    const period = await tx.one<PeriodRow>(`select * from vat_periods where id = $1 for update`, [r.period_id]);
    if (period.status !== 'in_review') throw conflict('period_not_in_review', `${periodLabel(period)} is ${period.status.replace('_', ' ')}.`);
    const open = await this.openBlockingQueries(tx, period);
    if (open > 0) throw conflict('open_queries', `Resolve the ${open} open blocking question(s) before signing off.`);
    const rebuilt = await this.build(tx, period);
    if (rebuilt.fingerprint !== r.fingerprint) {
      throw conflict('ledger_changed', 'The books changed after this draft was prepared. Prepare a new draft, check it, then sign off.', {
        draftFingerprint: r.fingerprint,
        currentFingerprint: rebuilt.fingerprint,
      });
    }
    await tx.exec(`update vat_returns set status = 'signed_off', signed_off_by = $2, signed_off_at = now() where id = $1`, [r.id, s.userId]);
    await tx.exec(`update vat_periods set status = 'signed_off' where id = $1`, [period.id]);
    await this.audit.log(tx, 'return.signed_off', 'vat_return', r.id, {
      period: periodLabel(period),
      version: r.version,
      fingerprint: r.fingerprint,
      netPayableCents: r.figures.netPayable,
    });
    return { returnId: r.id, status: 'signed_off' as const, fingerprint: r.fingerprint, periodLabel: periodLabel(period) };
  }

  async get(tx: Tx, orgId: string, returnId: string) {
    const r = await tx.maybe<ReturnRow & { prepared_by_name: string | null; signed_off_by_name: string | null }>(
      `select r.*, pu.full_name as prepared_by_name, su.full_name as signed_off_by_name
       from vat_returns r left join users pu on pu.id = r.prepared_by left join users su on su.id = r.signed_off_by
       where r.id = $1 and r.org_id = $2`,
      [returnId, orgId],
    );
    if (!r) throw notFound('VAT return');
    return r;
  }

  async periods(tx: Tx, orgId: string) {
    return tx.many(
      `select p.id, p.starts_on, p.ends_on, p.frequency, p.status, p.due_on, p.extended_due_on,
              r.id as return_id, r.version, r.status as return_status, (r.figures->>'netPayable')::bigint as net_payable_cents,
              (r.figures->>'creditCarriedForward')::bigint as credit_carried_forward_cents, r.mra_reference
       from vat_periods p
       left join lateral (select * from vat_returns vr where vr.period_id = p.id and vr.status <> 'superseded'
                          order by vr.version desc limit 1) r on true
       where p.org_id = $1 order by p.starts_on desc`,
      [orgId],
    );
  }
}
