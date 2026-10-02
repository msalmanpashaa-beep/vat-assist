import type { ExtractedInvoice } from '@vat-assist/shared';
import { describe, expect, it } from 'vitest';
import { type CheckContext, nameSimilarity, runChecks } from '../src/modules/documents/checks';
import { empty, field } from '../src/modules/documents/extraction/provider';
import { canAutoPost, scoreExtraction } from '../src/modules/documents/scoring';

const inv = (o: Partial<ExtractedInvoice> = {}): ExtractedInvoice => ({
  documentType: 'vat_invoice', hasVatInvoiceWords: true,
  supplierName: field('Grossiste Demo Ltd', 0.97), supplierVatNumber: field('27999902', 0.97), supplierBrn: empty(),
  buyerName: field('Boutik Demo Ltd', 0.95), buyerVatNumber: empty(), invoiceNumber: field('INV-1', 0.97),
  invoiceDate: field('2026-08-03', 0.97), currency: field('MUR', 0.99),
  netCents: field(400_000, 0.97), vatCents: field(60_000, 0.97), totalCents: field(460_000, 0.97), lines: [], ...o,
});
const ctx: CheckContext = {
  orgNames: ['Boutik Demo Ltd'], orgVatNumber: '99999902', today: '2026-10-01', booksStart: '2026-07-01',
  claimWindowMonths: 24, invoicePeriodEnd: '2026-09-30', standardRateBp: 1500, duplicateOf: null,
  nearDuplicateIds: [], mraListLoaded: false, supplierOnMraList: null,
};
const codes = (x: ExtractedInvoice, c: Partial<CheckContext> = {}) => runChecks(x, { ...ctx, ...c }).map((f) => f.code);

describe('document checks and confidence', () => {
  it('a clean VAT invoice raises nothing and can post without a reviewer', () => {
    expect(codes(inv())).toEqual([]);
    const s = scoreExtraction(inv(), [], 0.75);
    expect(s.score).toBeGreaterThan(0.9);
    expect(canAutoPost(s.score, [], 0.85, false)).toBe(true);
  });

  it('VAT shown but no supplier VAT number: blocking, the VAT cannot be claimed as read', () => {
    const x = inv({ supplierVatNumber: empty() });
    const flags = runChecks(x, ctx);
    expect(flags.find((f) => f.code === 'missing_supplier_vat_number')?.severity).toBe('blocking');
    expect(scoreExtraction(x, flags, 0.75).route).toBe('review');
  });

  it('figures that do not add up are caught', () => {
    expect(codes(inv({ totalCents: field(470_000, 0.9) })).some((c) => /total|sum|arith/.test(c))).toBe(true);
  });

  it('an invoice addressed to someone else is flagged', () => {
    expect(codes(inv({ buyerName: field('Another Business Ltd', 0.9) }))).toContain('buyer_name_mismatch');
  });

  it('input VAT older than the claim window is blocked', () => {
    expect(codes(inv(), { today: '2029-01-15' }).some((c) => /claim_window/.test(c))).toBe(true);
  });

  it('a duplicate or probable duplicate stops automatic posting', () => {
    expect(codes(inv(), { duplicateOf: 'doc-1' }).length).toBeGreaterThan(0);
    expect(codes(inv(), { nearDuplicateIds: ['doc-2'] })).toContain('possible_duplicate_image');
    expect(canAutoPost(0.99, ['possible_duplicate_image'], 0.85, false)).toBe(false);
  });

  it('categories marked for review never auto-post', () => {
    expect(canAutoPost(0.99, [], 0.85, true)).toBe(false);
  });

  it('name matching ignores case, punctuation and company suffixes', () => {
    expect(nameSimilarity('Boutik Demo Ltd', 'BOUTIK DEMO LIMITED')).toBeGreaterThanOrEqual(0.99);
    expect(nameSimilarity('Boutik Demo Ltd', 'Island Power Demo Ltd')).toBeLessThan(0.5);
  });
});
