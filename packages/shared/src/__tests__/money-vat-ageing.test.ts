import { describe, expect, it } from 'vitest';
import { formatRs, mulDivRound, rupeesToCents } from '../money';
import { splitGross, vatFromGross, vatFromNet } from '../vat';
import { ageOpenItems, bucketFor } from '../ageing';
import { renderTemplate, positionalVariables } from '../templates';

describe('money', () => {
  it('rounds half away from zero exactly', () => {
    expect(mulDivRound(5, 1, 2)).toBe(3);
    expect(mulDivRound(-5, 1, 2)).toBe(-3);
    expect(rupeesToCents('1,234.505')).toBe(123451);
    expect(rupeesToCents(25)).toBe(2500);
  });
  it('formats rupees per locale', () => {
    expect(formatRs(123456789, 'en')).toBe('Rs 1,234,567.89');
    expect(formatRs(123456789, 'fr')).toBe('Rs 1 234 567,89');
  });
});

describe('VAT maths at 15%', () => {
  it('computes VAT from net and from VAT-inclusive gross', () => {
    expect(vatFromNet(20000_00, 1500)).toBe(3000_00);
    // Rs 25 deposit, VAT-inclusive: 2500 × 15/115 = 326.087 → 326 cents
    expect(vatFromGross(2500, 1500)).toBe(326);
    expect(splitGross(2500, 1500)).toEqual({ net: 2174, vat: 326 });
  });
});

describe('ageing buckets 0–30, 31–60, 61–90, 90+', () => {
  it('puts boundary days in the right bucket', () => {
    expect([0, 30, 31, 60, 61, 90, 91].map(bucketFor)).toEqual(['0-30', '0-30', '31-60', '31-60', '61-90', '61-90', '90+']);
  });
  it('totals per contact and overall', () => {
    const r = ageOpenItems(
      [
        { transactionId: 'a', contactId: 'c1', contactName: 'A', reference: '1', issueDate: '2026-09-15', dueDate: null, outstandingCents: 1000 },
        { transactionId: 'b', contactId: 'c1', contactName: 'A', reference: '2', issueDate: '2026-06-01', dueDate: null, outstandingCents: 500 },
        { transactionId: 'c', contactId: 'c2', contactName: 'B', reference: '3', issueDate: '2026-08-15', dueDate: null, outstandingCents: 200 },
      ],
      '2026-10-01',
    );
    expect(r.total).toBe(1700);
    expect(r.buckets).toEqual({ '0-30': 1000, '31-60': 200, '61-90': 0, '90+': 500 });
    expect(r.contacts[0]?.contactId).toBe('c1');
  });
});

describe('reminder templates', () => {
  it('renders all three languages with the same variables', () => {
    const vars = { business: 'Boutik Demo', period: 'Q3 2026', date: '20/10/2026', amount: 'Rs 4,870.00' };
    for (const l of ['en', 'fr', 'mfe'] as const) expect(renderTemplate('vat_due_tomorrow', l, vars)).not.toMatch(/\{\{/);
    expect(positionalVariables('vat_due_tomorrow', vars)).toEqual({ '1': 'Boutik Demo', '2': 'Q3 2026', '3': '20/10/2026', '4': 'Rs 4,870.00' });
  });
});
