/** All money is integer cents of Mauritian rupees (Rs 1.00 = 100). Never floats. */
export type Cents = number;

export function assertCents(n: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer number of cents, got ${n}`);
  return n;
}

/** Rupees as typed by a person (e.g. "1,234.50" or 1234.5) to cents, rounding half away from zero. */
export function rupeesToCents(rupees: number | string): Cents {
  const s = typeof rupees === 'number' ? rupees.toFixed(4) : rupees.replace(/[\s,]/g, '').replace(/^Rs\.?/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Not a rupee amount: ${rupees}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const padded = (frac + '000').slice(0, 3);
  let cents = BigInt(whole ?? '0') * 100n + BigInt(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1n;
  return Number(neg ? -cents : cents);
}

/** round(a * num / den), half away from zero, exact (BigInt). den must be positive. */
export function mulDivRound(a: Cents, num: number, den: number): Cents {
  if (den <= 0) throw new Error('den must be positive');
  const A = BigInt(a);
  const N = BigInt(num);
  const D = BigInt(den);
  const negative = (A < 0n) !== (N < 0n);
  const prod = (A < 0n ? -A : A) * (N < 0n ? -N : N);
  const q = (prod * 2n + D) / (2n * D);
  return Number(negative ? -q : q);
}

export type Locale = 'en' | 'fr' | 'mfe';

/** "Rs 1,234.50" (en) or "Rs 1 234,50" (fr, mfe). */
export function formatRs(cents: Cents, locale: Locale = 'en'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const rupees = Math.floor(abs / 100).toString();
  const c = (abs % 100).toString().padStart(2, '0');
  const sep = locale === 'en' ? ',' : ' ';
  const dec = locale === 'en' ? '.' : ',';
  return `${sign}Rs ${rupees.replace(/\B(?=(\d{3})+(?!\d))/g, sep)}${dec}${c}`;
}

export function sum(values: readonly number[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}
