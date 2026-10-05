import { describe, expect, it } from 'vitest';
import { activation, churned, filingRecord, PILOT_TARGETS, type PilotRow, quarterBounds, quarterOf, reviewerMinutes, scorecard } from '../src/modules/admin/pilot-metrics';

const signedUp = new Date('2026-07-01T06:00:00Z');
const at = (iso: string) => new Date(iso);
const row = (o: Partial<PilotRow> = {}): PilotRow => ({
  orgId: 'o1', orgName: 'Boutik', cohort: 'pilot-1', signedUpAt: signedUp, filesElectronically: true,
  openingAt: at('2026-07-02T08:00:00Z'), docs14d: 6, sales14d: 3, lastOwnerActivity: at('2026-09-30T08:00:00Z'),
  staffActionTimes: [], periods: [], referrals: 0, subscriptionStatus: 'active', ...o,
});
const q3 = { periodId: 'p3', startsOn: '2026-07-01', endsOn: '2026-09-30', dueOn: '2026-10-20', extendedDueOn: '2026-11-03', status: 'filed', filedAt: null as string | null };

describe('pilot metrics', () => {
  it('activation needs opening balances, 5 documents and a day of sales within 14 days', () => {
    expect(activation(row())).toEqual({ activated: true, missing: [] });
    expect(activation(row({ openingAt: at('2026-07-20T08:00:00Z'), docs14d: 3, sales14d: 0 })).missing).toEqual(['opening balances', '2 more document(s)', 'a day of sales']);
    expect(activation(row({ openingAt: null })).activated).toBe(false);
  });

  it('reviewer minutes: actions within 15 minutes are one sitting, each sitting adds 3 minutes of reading', () => {
    const t = (min: number) => new Date(signedUp.getTime() + min * 60_000);
    expect(reviewerMinutes([])).toBe(0);
    expect(reviewerMinutes([t(0)])).toBe(3);
    expect(reviewerMinutes([t(10), t(0), t(5)])).toBe(13);
    expect(reviewerMinutes([t(0), t(5), t(10), t(60)])).toBe(16);
  });

  it('on-time filing uses the deadline that applies to the shop, in Mauritius time', () => {
    const today = '2026-12-01';
    expect(filingRecord(row({ periods: [{ ...q3, filedAt: '2026-11-02T19:30:00Z' }] }), today)).toMatchObject({ due: 1, onTime: 1 });
    expect(filingRecord(row({ periods: [{ ...q3, filedAt: '2026-11-03T21:00:00Z' }] }), today)).toMatchObject({ due: 1, onTime: 0 });
    expect(filingRecord(row({ filesElectronically: false, periods: [{ ...q3, filedAt: '2026-10-25T08:00:00Z' }] }), today)).toMatchObject({ due: 1, onTime: 0 });
    expect(filingRecord(row({ periods: [{ ...q3 }] }), '2026-10-25')).toMatchObject({ due: 0, onTime: 0 });
    expect(filingRecord(row({ periods: [{ ...q3, filedAt: '2026-10-05T08:00:00Z' }] }), '2026-10-06')).toMatchObject({ due: 1, onTime: 1 });
  });

  it('churn: cancelled, or no owner activity for 45 days', () => {
    expect(churned(row(), at('2026-10-20T08:00:00Z'))).toBe(false);
    expect(churned(row({ lastOwnerActivity: at('2026-10-01T08:00:00Z') }), at('2026-11-20T08:00:00Z'))).toBe(true);
    expect(churned(row({ subscriptionStatus: 'cancelled' }), at('2026-10-01T08:00:00Z'))).toBe(true);
  });

  it('scorecard compares the cohort with every target', () => {
    const t = (min: number) => new Date(at('2026-10-10T08:00:00Z').getTime() + min * 60_000);
    const rows = [
      row({ referrals: 2, staffActionTimes: [t(0), t(10)], lastOwnerActivity: at('2026-11-15T08:00:00Z'), periods: [{ ...q3, filedAt: '2026-11-01T08:00:00Z' }] }),
      row({ orgId: 'o2', openingAt: null, referrals: 1, staffActionTimes: [t(0), t(14), t(28)], lastOwnerActivity: at('2026-09-01T08:00:00Z'),
        periods: [{ ...q3, filedAt: '2026-11-10T08:00:00Z' }] }),
    ];
    const s = scorecard(rows, at('2026-11-20T08:00:00Z'), '2026-11-20');
    expect(s.shops).toEqual({ value: 2, target: PILOT_TARGETS.shops, pass: false });
    expect(s.activationRate).toMatchObject({ value: 0.5, activated: 1, pass: false });
    expect(s.reviewerMinutes).toMatchObject({ averagePerShop: 22, maxPerShop: 31, shopsAtOrOverTarget: 1, pass: false });
    expect(s.onTimeFilingRate).toMatchObject({ value: 0.5, onTime: 1, due: 2, pass: false });
    expect(s.churnRate).toMatchObject({ value: 0.5, churned: 1, pass: false });
    expect(s.referrals).toEqual({ value: 3, target: 3, pass: true });
  });

  it('quarters follow the calendar in Mauritius time', () => {
    expect(quarterOf('2026-10-02')).toBe('2026-Q4');
    expect(quarterBounds('2026-Q4')).toEqual({ label: '2026-Q4', startsOn: '2026-10-01', endsOn: '2026-12-31', from: '2026-10-01T00:00:00+04:00', to: '2027-01-01T00:00:00+04:00' });
    expect(quarterBounds('2027-Q1').endsOn).toBe('2027-03-31');
    expect(() => quarterBounds('2026-Q5')).toThrow();
  });
});
