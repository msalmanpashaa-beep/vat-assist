import { Injectable } from '@nestjs/common';
import type { IsoDate, VatPot } from '@vat-assist/shared';
import { notFound } from '../../common/errors';
import type { Tx } from '../../db/db.service';
import { type PeriodRow, PeriodsService, periodLabel } from '../core/periods.service';

/** The "VAT Pot": how much of the money in the till belongs to MRA for the current period. */
@Injectable()
export class VatPotService {
  constructor(private readonly periods: PeriodsService) {}

  async creditBroughtForward(tx: Tx, period: PeriodRow): Promise<number> {
    const prev = await this.periods.previous(tx, period);
    if (!prev) {
      const o = await tx.one<{ c: number }>(`select opening_vat_credit_cents as c from organisations where id = $1`, [period.org_id]);
      return o.c;
    }
    const r = await tx.maybe<{ c: number | null }>(
      `select (figures->>'creditCarriedForward')::bigint as c from vat_returns
       where period_id = $1 and status in ('signed_off', 'filed', 'paid') order by version desc limit 1`,
      [prev.id],
    );
    return r?.c ?? 0;
  }

  async vatTotals(tx: Tx, periodId: string): Promise<{ output: number; input: number }> {
    return tx.one(
      `select coalesce(sum(case when a.system_tag = 'output_vat' then jl.credit_cents - jl.debit_cents else 0 end), 0)::bigint as output,
              coalesce(sum(case when a.system_tag = 'input_vat' then jl.debit_cents - jl.credit_cents else 0 end), 0)::bigint as input
       from journal_lines jl
       join journal_entries je on je.id = jl.entry_id
       join accounts a on a.id = jl.account_id
       where je.period_id = $1 and je.source_type <> 'vat_settlement'`,
      [periodId],
    );
  }

  async compute(tx: Tx, orgId: string, periodId: string | null, today: IsoDate): Promise<VatPot> {
    const period = periodId
      ? await tx.maybe<PeriodRow>(`select * from vat_periods where id = $1 and org_id = $2`, [periodId, orgId])
      : await this.periods.ensure(tx, orgId, today);
    if (!period) throw notFound('VAT period');
    const { output, input } = await this.vatTotals(tx, period.id);
    const creditBF = await this.creditBroughtForward(tx, period);
    const unpaid = await tx.one<{ v: number }>(
      `select coalesce(sum(round(t.vat_cents::numeric * o.outstanding_cents / nullif(t.gross_cents, 0))), 0)::bigint as v
       from transactions t join v_open_items o on o.transaction_id = t.id
       where t.period_id = $1 and t.kind = 'sales_invoice' and o.outstanding_cents > 0`,
      [period.id],
    );
    const net = output - input - creditBF;
    return {
      periodId: period.id,
      periodLabel: periodLabel(period),
      startsOn: period.starts_on,
      endsOn: period.ends_on,
      status: period.status,
      outputVatCents: output,
      inputVatCents: input,
      creditBroughtForwardCents: creditBF,
      setAsideCents: Math.max(0, net),
      creditCarriedForwardCents: Math.max(0, -net),
      outputVatOnUnpaidSalesCents: unpaid.v,
      dueStandard: period.due_on,
      dueElectronic: period.extended_due_on,
    };
  }
}
