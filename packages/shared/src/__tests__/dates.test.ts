import { describe, expect, it } from 'vitest';
import { holidayCalendar, monthsElapsed, periodBounds, returnDeadlines } from '../dates';

// Expected values copied from MRA's published tax calendar for July–December 2026
// (https://www.mra.mu/index.php/important-dates). 2 November 2026 is a public holiday, which is why the
// September/Q3 electronic deadline lands on Tuesday 3 November.
const cal = holidayCalendar(['2026-11-02']);

describe('returnDeadlines (MRA calendar Jul–Dec 2026)', () => {
  it.each([
    ['2026-06-30', '2026-07-20', '2026-07-31'],
    ['2026-07-31', '2026-08-20', '2026-08-31'],
    ['2026-08-31', '2026-09-21', '2026-09-30'],
    ['2026-09-30', '2026-10-20', '2026-11-03'],
    ['2026-10-31', '2026-11-20', '2026-11-30'],
    ['2026-11-30', '2026-12-21', '2026-12-29'],
  ])('period ending %s → standard %s, electronic %s', (end, standard, electronic) => {
    expect(returnDeadlines(end, cal)).toEqual({ standard, electronic });
  });

  it('May period (electronic) is two working days before the end of June: 26 June 2026', () => {
    expect(returnDeadlines('2026-05-31', cal).electronic).toBe('2026-06-26');
  });
});

describe('periodBounds', () => {
  it('quarters end in March, June, September and December', () => {
    expect(periodBounds('quarterly', '2026-08-14')).toEqual({ startsOn: '2026-07-01', endsOn: '2026-09-30' });
    expect(periodBounds('monthly', '2026-02-10')).toEqual({ startsOn: '2026-02-01', endsOn: '2026-02-28' });
  });
});

describe('monthsElapsed', () => {
  it('counts whole months only', () => {
    expect(monthsElapsed('2024-08-31', '2026-08-30')).toBe(23);
    expect(monthsElapsed('2024-08-31', '2026-08-31')).toBe(24);
  });
});
