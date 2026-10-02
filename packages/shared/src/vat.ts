import { type Cents, mulDivRound } from './money';

/**
 * VAT classification codes used on every line.
 * SR standard-rated (15%) · ZR zero-rated · EX exempt · OS outside scope
 * RC reverse charge (s.14 VAT Act: registered buyer self-accounts on services from a non-resident)
 * BL VAT paid but blocked by s.21(2) (cars, entertainment, ...) — becomes cost
 * NC VAT paid but not claimable for another reason (no valid VAT invoice, personal use, claim window passed)
 */
export const VAT_CODES = ['SR', 'ZR', 'EX', 'OS', 'RC', 'BL', 'NC'] as const;
export type VatCode = (typeof VAT_CODES)[number];

/** Fallback only. The authoritative rate is the effective-dated `standard_rate_bp` rule in the database. */
export const DEFAULT_STANDARD_RATE_BP = 1500;

/** MRA e-invoice "Types of Supplies" codes (Standard e-Invoice Template) — keeps sales data EBS-ready. */
export const MRA_SUPPLY_TYPE: Partial<Record<VatCode, string>> = {
  SR: 'TC01',
  ZR: 'TC02',
  EX: 'TC03',
  OS: 'TC06',
};

export function vatFromNet(netCents: Cents, rateBp: number): Cents {
  return mulDivRound(netCents, rateBp, 10_000);
}

/** VAT inside a VAT-inclusive amount: gross × rate / (1 + rate). */
export function vatFromGross(grossCents: Cents, rateBp: number): Cents {
  return mulDivRound(grossCents, rateBp, 10_000 + rateBp);
}

export function splitGross(grossCents: Cents, rateBp: number): { net: Cents; vat: Cents } {
  const vat = vatFromGross(grossCents, rateBp);
  return { net: grossCents - vat, vat };
}

/** Output-side rate for a sales line of this code. */
export function salesRateBp(code: VatCode, standardRateBp: number): number {
  return code === 'SR' ? standardRateBp : 0;
}

/** Tolerance used when checking a supplier's VAT arithmetic: Rs 1 or 0.5% of the VAT, whichever is larger. */
export function vatMathTolerance(vatCents: Cents): Cents {
  return Math.max(100, Math.round(Math.abs(vatCents) * 0.005));
}

/** Mauritius uses the 8-digit Tax Account Number (TAN) as the VAT registration number. */
export function normaliseVatNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

export function isPlausibleMuVatNumber(v: string | null): boolean {
  return !!v && /^[0-9]{8}$/.test(v);
}
