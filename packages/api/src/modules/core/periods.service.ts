import { Injectable } from '@nestjs/common';
import { type FilingFrequency, holidayCalendar, type HolidayCalendar, type IsoDate, periodBounds, returnDeadlines, addDays } from '@vat-assist/shared';
import type { Tx } from '../../db/db.service';

export interface PeriodRow {
  id: string;
  org_id: string;
  starts_on: IsoDate;
  ends_on: IsoDate;
  frequency: FilingFrequency;
  status: 'open' | 'in_review' | 'signed_off' | 'filed' | 'paid' | 'closed';
  due_on: IsoDate;
  extended_due_on: IsoDate;
}

export const OPEN_STATUSES = ['open', 'in_review'] as const;

export function periodLabel(p: Pick<PeriodRow, 'starts_on' | 'ends_on' | 'frequency'>): string {
  const [y, m] = p.starts_on.split('-').map(Number) as [number, number];
  if (p.frequency === 'quarterly') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** VAT periods are created on demand from the organisation's filing frequency and MRA deadline rules. */
@Injectable()
export class PeriodsService {
  private cache?: { at: number; cal: HolidayCalendar };

  async calendar(tx: Tx): Promise<HolidayCalendar> {
    if (this.cache && Date.now() - this.cache.at < 600_000) return this.cache.cal;
    const rows = await tx.many<{ d: string }>(`select holiday_date::text as d from public_holidays`);
    this.cache = { at: Date.now(), cal: holidayCalendar(rows.map((r) => r.d)) };
    return this.cache.cal;
  }

  async ensure(tx: Tx, orgId: string, date: IsoDate): Promise<PeriodRow> {
    const existing = await tx.maybe<PeriodRow>(
      `select * from vat_periods where org_id = $1 and $2::date between starts_on and ends_on`,
      [orgId, date],
    );
    if (existing) return existing;
    const org = await tx.one<{ filing_frequency: FilingFrequency }>(`select filing_frequency from organisations where id = $1`, [orgId]);
    const { startsOn, endsOn } = periodBounds(org.filing_frequency, date);
    const d = returnDeadlines(endsOn, await this.calendar(tx));
    await tx.exec(
      `insert into vat_periods (org_id, starts_on, ends_on, frequency, due_on, extended_due_on)
       values ($1, $2, $3, $4, $5, $6) on conflict (org_id, starts_on) do nothing`,
      [orgId, startsOn, endsOn, org.filing_frequency, d.standard, d.electronic],
    );
    return tx.one<PeriodRow>(`select * from vat_periods where org_id = $1 and starts_on = $2`, [orgId, startsOn]);
  }

  /** Earliest period still accepting postings that ends on or after `date`; creates the next one if needed. */
  async firstOpenFrom(tx: Tx, orgId: string, date: IsoDate): Promise<PeriodRow> {
    let cursor = date;
    for (let i = 0; i < 40; i++) {
      const p = await this.ensure(tx, orgId, cursor);
      if ((OPEN_STATUSES as readonly string[]).includes(p.status)) return p;
      cursor = addDays(p.ends_on, 1);
    }
    throw new Error('No open VAT period found within 40 periods');
  }

  async byId(tx: Tx, periodId: string): Promise<PeriodRow> {
    return tx.one<PeriodRow>(`select * from vat_periods where id = $1`, [periodId]);
  }

  async previous(tx: Tx, p: PeriodRow): Promise<PeriodRow | null> {
    return tx.maybe<PeriodRow>(`select * from vat_periods where org_id = $1 and ends_on < $2 order by ends_on desc limit 1`, [p.org_id, p.starts_on]);
  }
}
