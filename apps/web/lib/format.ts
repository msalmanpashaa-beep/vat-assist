import { formatRs } from '@vat-assist/shared';

export const rs = (cents: number | string | null | undefined) => formatRs(Number(cents ?? 0), 'en');
export const day = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '–');
export const when = (ts: string | null | undefined) =>
  ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'Indian/Mauritius', dateStyle: 'medium', timeStyle: 'short' }) : '–';

/** What each check means, in the words a reviewer would use with the shop. */
export const FLAG_TEXT: Record<string, string> = {
  missing_supplier_vat_number: 'VAT is shown but the supplier VAT number is missing, so the VAT cannot be claimed as read.',
  not_marked_vat_invoice: 'The document does not call itself a VAT invoice.',
  buyer_name_mismatch: 'The invoice seems to be addressed to someone else.',
  buyer_vat_mismatch: 'The buyer VAT number does not match this business.',
  possible_duplicate_image: 'Looks like another photo of a document already recorded.',
  duplicate_invoice: 'Same supplier and invoice number as one already recorded.',
  claim_window_expired: 'Too old: the input VAT claim window has passed.',
  claim_window_near: 'The claim window for this VAT closes soon.',
  extraction_failed: 'The document could not be read automatically.',
  supplier_not_on_mra_list: 'Supplier not on the latest MRA list of VAT-registered persons.',
};
export const flagText = (code: string) => FLAG_TEXT[code] ?? code.replace(/_/g, ' ');

export const STAGES = ['open', 'in_review', 'signed_off', 'filed', 'paid', 'closed'] as const;
export const STAGE_LABEL: Record<string, string> = {
  open: 'Open', in_review: 'In review', signed_off: 'Signed off', filed: 'Filed', paid: 'Paid', closed: 'Closed',
};
