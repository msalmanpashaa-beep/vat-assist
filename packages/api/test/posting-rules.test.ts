import { describe, expect, it } from 'vitest';
import { assertBalanced, buildPosting, type DraftLine, type PostingInput, reverseLines } from '../src/modules/ledger/posting-rules';

const tagOf = (l: DraftLine) => ('tag' in l.account ? l.account.tag : l.account.id);
const sum = (ls: DraftLine[], side: 'debit' | 'credit', tag?: string) =>
  ls.filter((l) => !tag || tagOf(l) === tag).reduce((s, l) => s + l[side], 0);
const base = { settlement: 'credit', paymentMethod: null, contactId: 'contact-1', standardRateBp: 1500 } as const;
const post = (p: Partial<PostingInput> & Pick<PostingInput, 'kind' | 'grossCents' | 'lines'>) => buildPosting({ ...base, ...p });

describe('posting rules: every transaction kind produces a balanced double entry', () => {
  it('purchase on credit at 15%: cost and claimable input VAT against the supplier', () => {
    const ls = post({ kind: 'purchase_invoice', grossCents: 460_000, lines: [{ accountTag: 'stock_purchases', vatCode: 'SR', netCents: 400_000, vatCents: 60_000 }] });
    expect(() => assertBalanced(ls)).not.toThrow();
    expect(sum(ls, 'debit', 'stock_purchases')).toBe(400_000);
    expect(sum(ls, 'debit', 'input_vat')).toBe(60_000);
    expect(sum(ls, 'credit')).toBe(460_000);
    expect(ls.find((l) => l.credit === 460_000)?.contactId).toBe('contact-1');
  });

  it('blocked VAT (s.21(2), e.g. entertainment) becomes part of the cost: no input VAT', () => {
    const ls = post({ kind: 'purchase_invoice', settlement: 'cash', paymentMethod: 'cash', grossCents: 115_000, lines: [{ accountTag: 'meals', vatCode: 'BL', netCents: 100_000, vatCents: 15_000 }] });
    assertBalanced(ls);
    expect(sum(ls, 'debit', 'input_vat')).toBe(0);
    expect(sum(ls, 'debit', 'meals')).toBe(115_000);
    expect(sum(ls, 'credit', 'cash')).toBe(115_000);
  });

  it('reverse charge on an imported service: output and input VAT, net nil when claimable', () => {
    const ls = post({ kind: 'purchase_invoice', grossCents: 100_000, lines: [{ accountTag: 'software', vatCode: 'RC', netCents: 100_000, vatCents: 0 }] });
    assertBalanced(ls);
    expect(sum(ls, 'credit', 'output_vat')).toBe(15_000);
    expect(sum(ls, 'debit', 'input_vat')).toBe(15_000);
  });

  it('reverse charge with input tax blocked: output VAT due, VAT added to cost', () => {
    const ls = post({ kind: 'purchase_invoice', grossCents: 100_000, reverseChargeInputBlocked: true, lines: [{ accountTag: 'software', vatCode: 'RC', netCents: 100_000, vatCents: 0 }] });
    assertBalanced(ls);
    expect(sum(ls, 'credit', 'output_vat')).toBe(15_000);
    expect(sum(ls, 'debit', 'input_vat')).toBe(0);
    expect(sum(ls, 'debit', 'software')).toBe(115_000);
  });

  it('sales invoice on credit: debtor for the gross, sales and output VAT', () => {
    const ls = post({ kind: 'sales_invoice', grossCents: 460_000, lines: [{ vatCode: 'SR', netCents: 400_000, vatCents: 60_000 }] });
    assertBalanced(ls);
    expect(sum(ls, 'debit', 'debtors')).toBe(460_000);
    expect(sum(ls, 'credit', 'sales_sr')).toBe(400_000);
    expect(sum(ls, 'credit', 'output_vat')).toBe(60_000);
  });

  it('a credit note mirrors the invoice', () => {
    const lines = [{ vatCode: 'SR' as const, netCents: 400_000, vatCents: 60_000 }];
    const inv = post({ kind: 'sales_invoice', grossCents: 460_000, lines });
    const cn = post({ kind: 'sales_credit_note', grossCents: 460_000, lines });
    for (const t of ['debtors', 'sales_sr', 'output_vat']) {
      expect(sum(cn, 'debit', t)).toBe(sum(inv, 'credit', t));
      expect(sum(cn, 'credit', t)).toBe(sum(inv, 'debit', t));
    }
  });

  it('daily takings: each payment method to its own clearing account, VAT by rate', () => {
    const ls = post({
      kind: 'daily_takings', settlement: null, contactId: null, grossCents: 790_000,
      lines: [
        { vatCode: 'SR', netCents: 500_000, vatCents: 75_000, paymentMethod: 'cash' },
        { vatCode: 'SR', netCents: 100_000, vatCents: 15_000, paymentMethod: 'juice' },
        { vatCode: 'ZR', netCents: 80_000, vatCents: 0, paymentMethod: 'cash' },
        { vatCode: 'EX', netCents: 20_000, vatCents: 0, paymentMethod: 'card' },
      ],
    });
    assertBalanced(ls);
    expect(sum(ls, 'debit', 'cash')).toBe(655_000);
    expect(sum(ls, 'debit', 'juice_clearing')).toBe(115_000);
    expect(sum(ls, 'debit', 'card_clearing')).toBe(20_000);
    expect(sum(ls, 'credit', 'output_vat')).toBe(90_000);
  });

  it('Rs 25 deposit by Stripe: Rs 21.74 deposit liability + Rs 3.26 output VAT', () => {
    const ls = post({ kind: 'deposit', settlement: 'cash', paymentMethod: 'stripe', grossCents: 2_500, lines: [{ vatCode: 'SR', netCents: 2_174, vatCents: 326 }] });
    assertBalanced(ls);
    expect(sum(ls, 'debit', 'stripe_clearing')).toBe(2_500);
    expect(sum(ls, 'credit', 'customer_deposits')).toBe(2_174);
    expect(sum(ls, 'credit', 'output_vat')).toBe(326);
  });

  it('reversal swaps every side; unbalanced entries are refused', () => {
    const ls = post({ kind: 'sales_invoice', grossCents: 460_000, lines: [{ vatCode: 'SR', netCents: 400_000, vatCents: 60_000 }] });
    const rev = reverseLines(ls);
    rev.forEach((l, i) => {
      expect(l.debit).toBe(ls[i]!.credit);
      expect(l.credit).toBe(ls[i]!.debit);
    });
    expect(() => assertBalanced([{ account: { tag: 'cash' }, debit: 100, credit: 0 }])).toThrow();
  });
});
