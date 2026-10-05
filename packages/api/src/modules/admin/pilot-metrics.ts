/**
 * Pilot scorecard. Pure functions over per-business data, so the rules are unit-tested and visible in one place.
 * Targets: 10 shops; reviewer time under 20 minutes per shop per quarter (given); the rest are proposals to agree.
 */
export const PILOT_TARGETS = {
  shops: 10,
  activationRate: 0.8,
  reviewerMinutesPerShopQuarter: 20,
  onTimeFilingRate: 0.95,
  churnRate: 0.1,
  referrals: 3,
} as const;

/** Activated = within 14 days of sign-up: opening balances, at least 5 documents, and at least one day of sales. */
export const ACTIVATION = { withinDays: 14, minDocuments: 5, minSales: 1 } as const;
/** A shop with no owner activity for this long counts as churned (as does a cancelled subscription). */
export const DORMANT_DAYS = 45;
/** Reviewer-minute estimate: actions closer than this belong to one sitting; each sitting adds reading time. */
export const SESSION_GAP_MINUTES = 15;
export const LEAD_MINUTES = 3;

export interface PilotPeriod {
  periodId: string;
  startsOn: string;
  endsOn: string;
  dueOn: string;
  extendedDueOn: string;
  status: string;
  filedAt: string | null;
}

export interface PilotRow {
  orgId: string;
  orgName: string;
  cohort: string | null;
  signedUpAt: Date;
  filesElectronically: boolean;
  openingAt: Date | null;
  docs14d: number;
  sales14d: number;
  lastOwnerActivity: Date | null;
  staffActionTimes: Date[];
  periods: PilotPeriod[];
  referrals: number;
  subscriptionStatus: string | null;
}

const DAY = 86_400_000;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** Calendar date in Mauritius (UTC+4, no daylight saving). */
const mruDate = (iso: string | Date) => new Date(new Date(iso).getTime() + 4 * 3_600_000).toISOString().slice(0, 10);

export function activation(r: PilotRow): { activated: boolean; missing: string[] } {
  const missing: string[] = [];
  const deadline = r.signedUpAt.getTime() + ACTIVATION.withinDays * DAY;
  if (!r.openingAt || r.openingAt.getTime() > deadline) missing.push('opening balances');
  if (r.docs14d < ACTIVATION.minDocuments) missing.push(`${ACTIVATION.minDocuments - r.docs14d} more document(s)`);
  if (r.sales14d < ACTIVATION.minSales) missing.push('a day of sales');
  return { activated: missing.length === 0, missing };
}

/** Estimated reviewer minutes from the times of their recorded actions (sittings separated by a 15-minute gap). */
export function reviewerMinutes(times: Date[], gap = SESSION_GAP_MINUTES, lead = LEAD_MINUTES): number {
  if (!times.length) return 0;
  const t = times.map((d) => d.getTime()).sort((a, b) => a - b);
  let total = 0;
  let start = t[0]!;
  let prev = t[0]!;
  for (const x of t.slice(1)) {
    if (x - prev > gap * 60_000) {
      total += (prev - start) / 60_000 + lead;
      start = x;
    }
    prev = x;
  }
  total += (prev - start) / 60_000 + lead;
  return Math.round(total);
}

/** Returns that were due (or already filed) and how many were filed by the deadline that applies to the shop. */
export function filingRecord(r: PilotRow, today: string): { due: number; onTime: number; late: string[] } {
  let due = 0;
  let onTime = 0;
  const late: string[] = [];
  for (const p of r.periods) {
    const deadline = r.filesElectronically ? p.extendedDueOn : p.dueOn;
    if (deadline > today && !p.filedAt) continue;
    due++;
    if (p.filedAt && mruDate(p.filedAt) <= deadline) onTime++;
    else late.push(`${p.startsOn}..${p.endsOn}`);
  }
  return { due, onTime, late };
}

export function churned(r: PilotRow, now: Date): boolean {
  if (r.subscriptionStatus === 'cancelled') return true;
  const last = (r.lastOwnerActivity ?? r.signedUpAt).getTime();
  return now.getTime() - last > DORMANT_DAYS * DAY;
}

export function scorecard(rows: PilotRow[], now: Date, today: string) {
  const n = rows.length;
  const activated = rows.filter((r) => activation(r).activated).length;
  const minutes = rows.map((r) => reviewerMinutes(r.staffActionTimes));
  const over = minutes.filter((m) => m >= PILOT_TARGETS.reviewerMinutesPerShopQuarter).length;
  const filings = rows.map((r) => filingRecord(r, today));
  const due = filings.reduce((s, f) => s + f.due, 0);
  const onTime = filings.reduce((s, f) => s + f.onTime, 0);
  const churn = rows.filter((r) => churned(r, now)).length;
  const referrals = rows.reduce((s, r) => s + r.referrals, 0);
  const rate = (a: number, b: number) => (b ? round3(a / b) : null);
  return {
    shops: { value: n, target: PILOT_TARGETS.shops, pass: n >= PILOT_TARGETS.shops },
    activationRate: { value: rate(activated, n), activated, target: PILOT_TARGETS.activationRate, pass: n > 0 && activated / n >= PILOT_TARGETS.activationRate },
    reviewerMinutes: {
      averagePerShop: n ? Math.round(minutes.reduce((s, m) => s + m, 0) / n) : 0,
      maxPerShop: n ? Math.max(...minutes) : 0,
      shopsAtOrOverTarget: over,
      target: PILOT_TARGETS.reviewerMinutesPerShopQuarter,
      pass: over === 0,
    },
    onTimeFilingRate: { value: rate(onTime, due), onTime, due, target: PILOT_TARGETS.onTimeFilingRate, pass: due === 0 || onTime / due >= PILOT_TARGETS.onTimeFilingRate },
    churnRate: { value: rate(churn, n), churned: churn, target: PILOT_TARGETS.churnRate, pass: n === 0 || churn / n <= PILOT_TARGETS.churnRate },
    referrals: { value: referrals, target: PILOT_TARGETS.referrals, pass: referrals >= PILOT_TARGETS.referrals },
  };
}

/** "2026-Q4" for a Mauritius calendar date. */
export function quarterOf(today: string): string {
  return `${today.slice(0, 4)}-Q${Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1}`;
}

/** Bounds of a calendar quarter in Mauritius time, as instants for the database. */
export function quarterBounds(q: string): { label: string; startsOn: string; endsOn: string; from: string; to: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) throw new Error(`not a quarter: ${q}`);
  const year = Number(m[1]);
  const first = (Number(m[2]) - 1) * 3 + 1;
  const pad = (x: number) => String(x).padStart(2, '0');
  const startsOn = `${year}-${pad(first)}-01`;
  const next = first + 3 > 12 ? `${year + 1}-01-01` : `${year}-${pad(first + 3)}-01`;
  const endsOn = new Date(new Date(`${next}T00:00:00Z`).getTime() - DAY).toISOString().slice(0, 10);
  return { label: q, startsOn, endsOn, from: `${startsOn}T00:00:00+04:00`, to: `${next}T00:00:00+04:00` };
}
