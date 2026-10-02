import {
  addDays, type ExtractedInvoice, type IsoDate, isPlausibleMuVatNumber, monthsElapsed, normaliseVatNumber,
  vatFromNet, vatMathTolerance,
} from '@vat-assist/shared';

export type Severity = 'blocking' | 'warning';
export interface Flag {
  code: string;
  severity: Severity;
  message: string;
}

export interface CheckContext {
  orgNames: string[];
  orgVatNumber: string | null;
  today: IsoDate;
  booksStart: IsoDate;
  claimWindowMonths: number;
  /** End of the VAT period the invoice date falls in. */
  invoicePeriodEnd: IsoDate | null;
  standardRateBp: number;
  duplicateOf: string | null;
  nearDuplicateIds: string[];
  mraListLoaded: boolean;
  supplierOnMraList: boolean | null;
}

const SUFFIXES = /\b(ltd|limited|ltee|co|cie|company|sarl|plc|inc|the)\b/g;
export function normaliseName(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIXES, ' ').split(/\s+/).filter(Boolean);
}

/** Token overlap (Jaccard) between two business names, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const A = new Set(normaliseName(a));
  const B = new Set(normaliseName(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Every rule that decides whether a captured invoice can be trusted. Pure: unit-tested without a database. */
export function runChecks(x: ExtractedInvoice, c: CheckContext): Flag[] {
  const f: Flag[] = [];
  const add = (code: string, severity: Severity, message: string) => f.push({ code, severity, message });
  const date = x.invoiceDate.value;
  const net = x.netCents.value;
  const vat = x.vatCents.value;
  const total = x.totalCents.value;
  const supplierVat = normaliseVatNumber(x.supplierVatNumber.value);

  if (['statement', 'mra_letter', 'other'].includes(x.documentType)) add('not_an_invoice', 'blocking', 'This does not look like an invoice or receipt.');
  if (!date) add('missing_date', 'blocking', 'No invoice date could be read.');
  if (date && date > addDays(c.today, 1)) add('future_date', 'blocking', 'The invoice date is in the future.');
  if (date && date < c.booksStart) add('before_books_start', 'blocking', 'Dated before the business started using VAT Assist.');
  if (total == null) add('missing_total', 'blocking', 'No total could be read.');
  if (net != null && vat != null && total != null && Math.abs(net + vat - total) > 100) {
    add('total_mismatch', 'blocking', 'Amount before VAT plus VAT does not equal the total.');
  }
  if (net != null && vat != null && vat > 0 && Math.abs(vat - vatFromNet(net, c.standardRateBp)) > vatMathTolerance(vat)) {
    add('vat_math', 'warning', 'The VAT is not 15% of the amount before VAT. Mixed rates or an error.');
  }
  if ((vat ?? 0) > 0 && !supplierVat) add('missing_supplier_vat_number', 'blocking', 'VAT is charged but the supplier VAT number is missing, so it cannot be claimed.');
  if (supplierVat && !isPlausibleMuVatNumber(supplierVat)) add('supplier_vat_format', 'warning', 'The supplier VAT number is not 8 digits.');
  if ((vat ?? 0) > 0 && x.hasVatInvoiceWords === false) add('not_marked_vat_invoice', 'warning', 'The document is not marked "VAT invoice".');
  if (x.buyerName.value && c.orgNames.length && Math.max(...c.orgNames.map((n) => nameSimilarity(n, x.buyerName.value as string))) < 0.5) {
    add('buyer_name_mismatch', 'warning', 'The buyer name on the invoice does not match your business.');
  }
  const buyerVat = normaliseVatNumber(x.buyerVatNumber.value);
  if (buyerVat && c.orgVatNumber && buyerVat !== c.orgVatNumber) add('buyer_vat_mismatch', 'warning', 'The buyer VAT number is not yours.');
  if (x.currency.value && x.currency.value.toUpperCase() !== 'MUR') add('foreign_currency', 'blocking', 'Foreign currency: an exchange rate is needed.');
  if (c.invoicePeriodEnd && (vat ?? 0) > 0) {
    const elapsed = monthsElapsed(c.invoicePeriodEnd, c.today);
    if (elapsed > c.claimWindowMonths) add('claim_window_expired', 'blocking', `Older than the ${c.claimWindowMonths}-month input VAT claim window.`);
    else if (elapsed > c.claimWindowMonths - 3) add('claim_window_near', 'warning', 'Claim this soon: the input VAT claim window is closing.');
  }
  if (c.duplicateOf) add('duplicate_invoice', 'blocking', 'An invoice with the same supplier and number is already recorded.');
  if (c.nearDuplicateIds.length) add('possible_duplicate_image', 'warning', 'This photo looks very similar to one already sent.');
  if (c.mraListLoaded && c.supplierOnMraList === false) add('supplier_not_on_mra_list', 'warning', "The supplier VAT number is not on MRA's published list.");
  return f;
}
