import { randomBytes } from 'node:crypto';
import type { Locale } from '@vat-assist/shared';

/** No 0/O, 1/I/L: the reference is read off a phone and typed into a Juice or bank transfer narration. */
export const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newReference(): string {
  let s = 'VA';
  for (const b of randomBytes(6)) s += REFERENCE_ALPHABET.charAt(b % REFERENCE_ALPHABET.length);
  return s;
}

/** The pay link secret; only its SHA-256 is stored. */
export const newPayToken = (): string => randomBytes(24).toString('base64url');

/** How each rail is recorded in the books (and therefore which clearing or bank account it hits). */
export const RAIL_METHOD = { juice: 'juice', bank_transfer: 'bank', stripe: 'stripe', mips: 'mips', mock: 'card' } as const;
export type Rail = keyof typeof RAIL_METHOD;

export const RAIL_LABEL: Record<'juice' | 'bank_transfer', Record<Locale, string>> = {
  juice: { en: 'Juice', fr: 'Juice', mfe: 'Juice' },
  bank_transfer: { en: 'bank transfer', fr: 'virement bancaire', mfe: 'transfer labank' },
};
