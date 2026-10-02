import { describe, expect, it } from 'vitest';
import { resolveFeatures } from '../features';
import {
  autoAllocate, buildOpeningBalances, buildPayment, buildSalesInvoice, emptyOpeningForm, invoiceTotals,
  normaliseMuPhone, parseRupees, validateStaffInvite,
} from '../forms';

describe('amounts and phone numbers as people type them', () => {
  it('reads rupees in English and French styles', () => {
    expect(parseRupees('1,234.50')).toBe(123_450);
    expect(parseRupees('Rs 2,000')).toBe(200_000);
    expect(parseRupees('12,5')).toBe(1_250);
    expect(parseRupees('  ')).toBeNull();
    expect(parseRupees('12.345')).toBeNaN();
    expect(parseRupees('-5')).toBeNaN();
  });
  it('turns local mobiles into international form', () => {
    expect(normaliseMuPhone('5712 3456')).toBe('+23057123456');
    expect(normaliseMuPhone('+230 5712-3456')).toBe('+23057123456');
    expect(normaliseMuPhone('00230 57123456')).toBe('+23057123456');
    expect(normaliseMuPhone('1234')).toBeNull();
  });
});

describe('opening balances screen', () => {
  it('builds the API request and ignores blank rows', () => {
    const f = emptyOpeningForm();
    f.cash = '15,000'; f.stock = '180000'; f.vatCredit = '1,200.50';
    f.banks = [{ name: 'MCB current', amount: '250,000' }, { name: '', amount: '' }];
    f.customers = [{ name: 'Hotel Demo Ltd', amount: '1,200', date: '2026-05-10', phone: '5710 0021' }];
    f.suppliers = [{ name: 'Grossiste Demo Ltd', amount: '3,450', date: '2026-06-20' }];
    const r = buildOpeningBalances(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      cashInHandCents: 1_500_000, stockCents: 18_000_000, vatCreditCarriedForwardCents: 120_050,
      bankBalances: [{ name: 'MCB current', amountCents: 25_000_000 }],
      customersOwe: [{ name: 'Hotel Demo Ltd', amountCents: 120_000, date: '2026-05-10', phone: '+23057100021' }],
      suppliersOwed: [{ name: 'Grossiste Demo Ltd', amountCents: 345_000 }],
    });
  });
  it('explains what is wrong instead of saving', () => {
    const f = emptyOpeningForm();
    f.banks = [{ name: '', amount: '100' }];
    f.customers = [{ name: 'X', amount: 'abc' }];
    const r = buildOpeningBalances(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/name the account/);
  });
});

describe('credit invoice screen', () => {
  it('computes VAT per line like the server and sends a credit settlement', () => {
    expect(invoiceTotals([{ netCents: 400_000, vatCode: 'SR' }, { netCents: 10_000, vatCode: 'ZR' }])).toEqual({ netCents: 410_000, vatCents: 60_000, grossCents: 470_000 });
    const r = buildSalesInvoice({
      customerName: 'Hotel Demo Ltd', customerPhone: '5710 0021', reminderConsent: true, issueDate: '2026-10-02', dueDate: '2026-11-01',
      lines: [{ description: 'Catering supplies', amount: '4,000', vatCode: 'SR' }, { description: '', amount: '', vatCode: 'SR' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.settlement).toEqual({ mode: 'credit', dueDate: '2026-11-01' });
      expect(r.value.customerPhone).toBe('+23057100021');
      expect(r.value.customerReminderConsent).toBe(true);
      expect(r.value.totals.grossCents).toBe(460_000);
    }
  });
  it('refuses a due date before the invoice date, or reminders without a mobile', () => {
    const r = buildSalesInvoice({ customerName: 'A', reminderConsent: true, issueDate: '2026-10-02', dueDate: '2026-09-01', lines: [{ description: 'x', amount: '1', vatCode: 'SR' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/before the invoice date/), expect.stringMatching(/mobile/)]));
  });
});

describe('payment screens', () => {
  const open = [
    { transactionId: 'b', reference: 'INV-2', issueDate: '2026-09-15', outstandingCents: 460_000 },
    { transactionId: 'a', reference: 'OPEN', issueDate: '2026-05-10', outstandingCents: 120_000 },
  ];
  it('pays the oldest invoice first and leaves the rest unallocated', () => {
    expect(autoAllocate(200_000, open)).toEqual([{ invoiceId: 'a', amountCents: 120_000 }, { invoiceId: 'b', amountCents: 80_000 }]);
    expect(autoAllocate(700_000, open).reduce((s, x) => s + x.amountCents, 0)).toBe(580_000);
  });
  it('accepts partial payments and blocks over-allocation', () => {
    const ok = buildPayment({ kind: 'receipt', contactId: 'c', date: '2026-10-02', method: 'juice', amount: '2,000', allocations: { b: '1,500' } }, open);
    expect(ok.ok && ok.value.unallocatedCents).toBe(50_000);
    const tooMuch = buildPayment({ kind: 'payment', contactId: 'c', date: '2026-10-02', method: 'bank', amount: '1,000', allocations: { a: '1,300' } }, open);
    expect(tooMuch.ok).toBe(false);
  });
});

describe('admin and flags', () => {
  it('validates staff invitations', () => {
    expect(validateStaffInvite({ email: 'new@nexgen.test', fullName: 'New Reviewer', role: 'reviewer' })).toEqual([]);
    expect(validateStaffInvite({ email: 'nope', fullName: '', role: 'owner' })).toHaveLength(3);
  });
  it('defaults every feature on and applies overrides', () => {
    expect(resolveFeatures(null).credit_invoices).toBe(true);
    expect(resolveFeatures({ credit_invoices: false }).credit_invoices).toBe(false);
  });
});
