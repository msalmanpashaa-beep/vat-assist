import { type Cents } from './money';
import { type IsoDate, daysBetween } from './dates';

export const AGEING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];
export type AgeingBasis = 'invoice_date' | 'due_date';

export function bucketFor(days: number): AgeingBucket {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

export interface OpenItem {
  transactionId: string;
  contactId: string | null;
  contactName: string | null;
  reference: string | null;
  issueDate: IsoDate;
  dueDate: IsoDate | null;
  outstandingCents: Cents;
}

export interface AgedContact {
  contactId: string | null;
  contactName: string | null;
  total: Cents;
  buckets: Record<AgeingBucket, Cents>;
  items: Array<OpenItem & { days: number; bucket: AgeingBucket }>;
}

export interface AgeingReport {
  asOf: IsoDate;
  basis: AgeingBasis;
  total: Cents;
  buckets: Record<AgeingBucket, Cents>;
  contacts: AgedContact[];
}

const emptyBuckets = (): Record<AgeingBucket, Cents> => ({ '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });

/**
 * Age open items as at `asOf`. Default basis is days since invoice date (how shop owners think);
 * 'due_date' ages by days overdue, with not-yet-due items in 0-30.
 */
export function ageOpenItems(items: OpenItem[], asOf: IsoDate, basis: AgeingBasis = 'invoice_date'): AgeingReport {
  const byContact = new Map<string, AgedContact>();
  const totals = emptyBuckets();
  let total = 0;
  for (const item of items) {
    if (item.outstandingCents === 0) continue;
    const from = basis === 'due_date' ? item.dueDate ?? item.issueDate : item.issueDate;
    const days = Math.max(0, daysBetween(from, asOf));
    const bucket = bucketFor(days);
    const key = item.contactId ?? 'none';
    let c = byContact.get(key);
    if (!c) {
      c = { contactId: item.contactId, contactName: item.contactName, total: 0, buckets: emptyBuckets(), items: [] };
      byContact.set(key, c);
    }
    c.items.push({ ...item, days, bucket });
    c.buckets[bucket] += item.outstandingCents;
    c.total += item.outstandingCents;
    totals[bucket] += item.outstandingCents;
    total += item.outstandingCents;
  }
  const contacts = [...byContact.values()].sort((a, b) => b.buckets['90+'] - a.buckets['90+'] || b.total - a.total);
  for (const c of contacts) c.items.sort((a, b) => b.days - a.days);
  return { asOf, basis, total, buckets: totals, contacts };
}
