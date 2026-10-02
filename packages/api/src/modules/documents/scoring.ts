import type { ExtractedInvoice } from '@vat-assist/shared';
import type { Flag } from './checks';

const WEIGHTS = {
  supplierName: 0.15,
  invoiceNumber: 0.15,
  invoiceDate: 0.15,
  totalCents: 0.2,
  vatCents: 0.15,
  netCents: 0.1,
  supplierVatNumber: 0.1,
} as const;

export interface Score {
  score: number;
  route: 'owner_confirm' | 'review';
  blocking: string[];
  warnings: string[];
}

/** Weighted field confidence, minus 0.05 per warning. Any blocking flag sends the item to a reviewer. */
export function scoreExtraction(x: ExtractedInvoice, flags: Flag[], reviewThreshold: number): Score {
  let s = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as Array<[keyof typeof WEIGHTS, number]>) {
    const field = x[k];
    if (k === 'supplierVatNumber' && field.value == null && (x.vatCents.value ?? 0) === 0) {
      s += w; // no VAT charged: a missing VAT number is expected, not a weakness
      continue;
    }
    s += field.value == null ? 0 : w * Math.max(0, Math.min(1, field.confidence));
  }
  const warnings = flags.filter((f) => f.severity === 'warning').map((f) => f.code);
  const blocking = flags.filter((f) => f.severity === 'blocking').map((f) => f.code);
  s = Math.max(0, Math.min(1, s - 0.05 * warnings.length));
  const score = Math.round(s * 1000) / 1000;
  return { score, route: blocking.length || score < reviewThreshold ? 'review' : 'owner_confirm', blocking, warnings };
}

/** Straight to the books only when confident, flag-free and not a category that always needs an accountant. */
export function canAutoPost(score: number, flagCodes: string[], autoPostThreshold: number, alwaysReview: boolean): boolean {
  return score >= autoPostThreshold && flagCodes.length === 0 && !alwaysReview;
}
