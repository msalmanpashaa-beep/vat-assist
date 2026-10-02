/**
 * Calendar maths on ISO dates (YYYY-MM-DD), done in UTC so time zones never shift a day.
 * Deadline rules follow VAT Regulations 1998 reg. 9 as published in MRA's tax calendar:
 *   - standard: 20 days after the end of the taxable period
 *   - electronic filing AND payment: last day of the following month
 *   - May and November periods (electronic): two working days before the end of June / December
 *   - any deadline on a Saturday, Sunday or public holiday moves to the next working day
 */
export type IsoDate = string;

export interface HolidayCalendar {
  isHoliday(date: IsoDate): boolean;
}

export const NO_HOLIDAYS: HolidayCalendar = { isHoliday: () => false };

export function holidayCalendar(dates: Iterable<IsoDate>): HolidayCalendar {
  const set = new Set(dates);
  return { isHoliday: (d) => set.has(d) };
}

const DAY_MS = 86_400_000;

export function toUtcMs(d: IsoDate): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Not an ISO date: ${d}`);
  return Date.parse(`${d}T00:00:00Z`);
}

export function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromUtcMs(toUtcMs(d) + n * DAY_MS);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function addMonths(d: IsoDate, months: number): IsoDate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = Number(lastDayOfMonth(ny, nm).slice(8));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export function lastDayOfMonth(year: number, month1to12: number): IsoDate {
  return fromUtcMs(Date.UTC(year, month1to12, 0));
}

export function weekday(d: IsoDate): number {
  return new Date(toUtcMs(d)).getUTCDay(); // 0 Sunday … 6 Saturday
}

export function isWorkingDay(d: IsoDate, cal: HolidayCalendar): boolean {
  const w = weekday(d);
  return w !== 0 && w !== 6 && !cal.isHoliday(d);
}

export function onOrNextWorkingDay(d: IsoDate, cal: HolidayCalendar): IsoDate {
  let cur = d;
  for (let i = 0; i < 31 && !isWorkingDay(cur, cal); i++) cur = addDays(cur, 1);
  return cur;
}

export function workingDaysBefore(d: IsoDate, n: number, cal: HolidayCalendar): IsoDate {
  let cur = d;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, -1);
    if (isWorkingDay(cur, cal)) left--;
  }
  return cur;
}

export type FilingFrequency = 'monthly' | 'quarterly';

/** Calendar months, or calendar quarters ending March, June, September, December. */
export function periodBounds(frequency: FilingFrequency, anyDate: IsoDate): { startsOn: IsoDate; endsOn: IsoDate } {
  const [y, m] = anyDate.split('-').map(Number) as [number, number];
  if (frequency === 'monthly') {
    return { startsOn: `${y}-${String(m).padStart(2, '0')}-01`, endsOn: lastDayOfMonth(y, m) };
  }
  const qStart = Math.floor((m - 1) / 3) * 3 + 1;
  return { startsOn: `${y}-${String(qStart).padStart(2, '0')}-01`, endsOn: lastDayOfMonth(y, qStart + 2) };
}

export interface ReturnDeadlines {
  /** 20-day date. Safe for everyone. */
  standard: IsoDate;
  /** Date that applies when the return is filed AND the tax paid electronically. */
  electronic: IsoDate;
}

export function returnDeadlines(periodEndsOn: IsoDate, cal: HolidayCalendar): ReturnDeadlines {
  const [y, m] = periodEndsOn.split('-').map(Number) as [number, number];
  const standard = onOrNextWorkingDay(addDays(periodEndsOn, 20), cal);
  const followingY = m === 12 ? y + 1 : y;
  const followingM = m === 12 ? 1 : m + 1;
  const followingLast = lastDayOfMonth(followingY, followingM);
  const isMayOrNovPeriod = m === 5 || m === 11; // only monthly periods end in May or November
  const electronic = isMayOrNovPeriod
    ? workingDaysBefore(followingLast, 2, cal)
    : onOrNextWorkingDay(followingLast, cal);
  return { standard, electronic };
}

/** Today's date where the business is (Mauritius has no daylight saving: UTC+4 all year). */
export function todayIn(timeZone = 'Indian/Mauritius', now = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whole months from `from` to `to`, counting a partial month as not yet elapsed. */
export function monthsElapsed(from: IsoDate, to: IsoDate): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months;
}
