import { Injectable } from '@nestjs/common';
import { daysBetween, type PortfolioRow, todayIn } from '@vat-assist/shared';
import { AppConfig } from '../../config';
import { type Actor, type OrgScope, userCtx } from '../../common/auth-context';
import { Db } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { periodLabel } from '../core/periods.service';
import { TransactionsService } from '../ledger/transactions.service';
import { ReturnsService } from '../vat/returns.service';
import { VatPotService } from '../vat/vat-pot.service';
import { QueriesService } from './queries.service';

const STAFF = `('reviewer', 'senior_reviewer', 'admin')`;

/** Nex-Gen's console: every assigned client, what needs attention first, and one client's full file. */
@Injectable()
export class ReviewerService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly pot: VatPotService,
    private readonly returns: ReturnsService,
    private readonly queries: QueriesService,
    private readonly books: TransactionsService,
    private readonly audit: AuditService,
  ) {}

  async portfolio(a: Actor): Promise<PortfolioRow[]> {
    const today = todayIn(this.cfg.env.TZ_BUSINESS);
    const rows = await this.db.run(userCtx(a), (tx) =>
      tx.many<{
        org_id: string; org_name: string; period_id: string | null; starts_on: string | null; ends_on: string | null;
        frequency: 'monthly' | 'quarterly' | null; status: PortfolioRow['periodStatus']; due_on: string | null;
        docs: number; queries: number; late: number;
      }>(
        `select o.id as org_id, coalesce(o.trading_name, o.legal_name) as org_name,
                p.id as period_id, p.starts_on, p.ends_on, p.frequency, p.status, p.due_on,
                (select count(*)::int from documents d where d.org_id = o.id and d.status in ('needs_review', 'failed')) as docs,
                (select count(*)::int from queries q where q.org_id = o.id and q.status in ('open', 'answered')) as queries,
                (select count(*)::int from transactions t where t.org_id = o.id and t.is_late and t.status = 'posted' and t.period_id = p.id) as late
         from organisations o
         left join lateral (select * from vat_periods vp where vp.org_id = o.id and vp.status <> 'closed' order by vp.starts_on limit 1) p on true
         where not o.is_platform
           and exists (select 1 from memberships m where m.org_id = o.id and m.user_id = $1 and m.revoked_at is null and m.role in ${STAFF})
         order by p.due_on nulls last, org_name`,
        [a.userId],
      ),
    );
    return rows.map((r) => {
      const daysToDue = r.due_on ? daysBetween(today, r.due_on) : null;
      const urgency = daysToDue !== null && daysToDue <= 7 && r.status !== 'signed_off' ? 30 : 0;
      return {
        orgId: r.org_id,
        orgName: r.org_name,
        periodId: r.period_id,
        periodLabel: r.starts_on && r.ends_on && r.frequency ? periodLabel({ starts_on: r.starts_on, ends_on: r.ends_on, frequency: r.frequency }) : null,
        periodStatus: r.status,
        dueStandard: r.due_on,
        docsNeedingReview: r.docs,
        openQueries: r.queries,
        riskScore: Math.min(100, r.docs * 10 + r.queries * 15 + r.late * 10 + urgency),
      };
    });
  }

  async queue(a: Actor) {
    return this.db.run(userCtx(a), (tx) =>
      tx.many(
        `select d.id as document_id, d.org_id, coalesce(o.trading_name, o.legal_name) as org_name, d.status, d.kind,
                d.confidence, d.flags, d.created_at, d.original_filename,
                d.extraction->'supplierName'->>'value' as supplier,
                d.extraction->'invoiceNumber'->>'value' as invoice_number,
                (d.extraction->'totalCents'->>'value')::bigint as total_cents,
                t.id as transaction_id, t.settlement
         from documents d
         join organisations o on o.id = d.org_id
         left join transactions t on t.document_id = d.id and t.status <> 'void'
         where d.status in ('needs_review', 'failed')
           and exists (select 1 from memberships m where m.org_id = d.org_id and m.user_id = $1 and m.revoked_at is null and m.role in ${STAFF})
         order by d.created_at`,
        [a.userId],
      ),
    );
  }

  async clientFile(s: OrgScope) {
    const today = todayIn(this.cfg.env.TZ_BUSINESS);
    return this.db.run(userCtx(s), async (tx) => {
      const org = await tx.one(
        `select id, legal_name, trading_name, brn, vat_number, filing_frequency, files_and_pays_electronically, start_date, default_locale
         from organisations where id = $1`,
        [s.orgId],
      );
      const periods = await this.returns.periods(tx, s.orgId);
      const vatPot = await this.pot.compute(tx, s.orgId, null, today);
      const documents = await tx.many(
        `select id, kind, status, confidence, flags, original_filename, created_at,
                extraction->'supplierName'->>'value' as supplier, (extraction->'totalCents'->>'value')::bigint as total_cents
         from documents where org_id = $1 and status in ('awaiting_owner', 'needs_review', 'failed', 'rejected_quality')
         order by created_at desc limit 50`,
        [s.orgId],
      );
      const recent = await this.books.list(tx, s.orgId, { limit: 25 });
      const receivables = await this.books.ageing(tx, s.orgId, 'receivable', today, 'invoice_date');
      const payables = await this.books.ageing(tx, s.orgId, 'payable', today, 'invoice_date');
      const queries = await this.queries.list(tx, s.orgId);
      const auditChain = await this.audit.verify(tx, s.orgId);
      const members = await tx.many(
        `select u.full_name, u.phone_e164, u.email, m.role from memberships m join users u on u.id = m.user_id
         where m.org_id = $1 and m.revoked_at is null order by m.role`,
        [s.orgId],
      );
      return {
        org, periods, vatPot, documents, recentTransactions: recent, queries, auditChain, members,
        ageing: { receivable: { total: receivables.total, buckets: receivables.buckets }, payable: { total: payables.total, buckets: payables.buckets } },
      };
    });
  }
}
