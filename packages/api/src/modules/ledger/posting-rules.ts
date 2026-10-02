import { type VatCode, vatFromNet } from '@vat-assist/shared';

/**
 * Pure posting rules: a transaction in, balanced journal lines out. No I/O, so every rule is unit-tested.
 * Accounts are referenced by system tag (resolved to ids by the ledger service) or by explicit id.
 */
export type TxnKind =
  | 'purchase_invoice' | 'purchase_credit_note' | 'sales_invoice' | 'sales_credit_note'
  | 'daily_takings' | 'payment' | 'receipt' | 'deposit' | 'opening_balance' | 'journal';

export type AccountRef = { tag: string } | { id: string };

export interface DraftLine {
  account: AccountRef;
  debit: number;
  credit: number;
  vatCode?: VatCode;
  vatRole?: 'base' | 'tax';
  contactId?: string | null;
  memo?: string;
}

export interface PostingLine {
  accountId?: string | null;
  accountTag?: string | null;
  vatCode: VatCode;
  netCents: number;
  vatCents: number;
  paymentMethod?: 'cash' | 'card' | 'juice' | 'credit' | null;
  description?: string | null;
}

export interface PostingInput {
  kind: TxnKind;
  settlement: 'cash' | 'credit' | null;
  paymentMethod: 'cash' | 'bank' | 'juice' | 'card' | 'stripe' | 'mips' | null;
  contactId: string | null;
  grossCents: number;
  lines: PostingLine[];
  standardRateBp: number;
  /** Reverse charge on a service whose input tax is blocked (e.g. inbound digital services). */
  reverseChargeInputBlocked?: boolean;
}

export const METHOD_ACCOUNT: Record<string, string> = {
  cash: 'cash',
  bank: 'bank',
  juice: 'juice_clearing',
  card: 'card_clearing',
  stripe: 'stripe_clearing',
  mips: 'mips_clearing',
  credit: 'debtors',
};

const SALES_ACCOUNT: Partial<Record<VatCode, string>> = { SR: 'sales_sr', ZR: 'sales_zr', EX: 'sales_ex', OS: 'sales_os' };

export class PostingError extends Error {}

function push(out: DraftLine[], account: AccountRef, amount: number, side: 'debit' | 'credit', extra: Partial<DraftLine> = {}): void {
  if (amount === 0) return;
  // A negative amount on one side is a positive amount on the other.
  const s = amount < 0 ? (side === 'debit' ? 'credit' : 'debit') : side;
  const a = Math.abs(amount);
  out.push({ account, debit: s === 'debit' ? a : 0, credit: s === 'credit' ? a : 0, ...extra });
}

const flip = (side: 'debit' | 'credit') => (side === 'debit' ? 'credit' : 'debit');

function lineAccount(l: PostingLine, fallbackTag: string): AccountRef {
  if (l.accountId) return { id: l.accountId };
  return { tag: l.accountTag ?? fallbackTag };
}

function settlementAccount(input: PostingInput, side: 'receivable' | 'payable'): AccountRef {
  if (input.settlement === 'credit') return { tag: side === 'receivable' ? 'debtors' : 'creditors' };
  const tag = input.paymentMethod ? METHOD_ACCOUNT[input.paymentMethod] : undefined;
  if (!tag) throw new PostingError('A cash settlement needs a payment method');
  return { tag };
}

function purchase(input: PostingInput, sign: 1 | -1): DraftLine[] {
  const out: DraftLine[] = [];
  const dr: 'debit' | 'credit' = sign === 1 ? 'debit' : 'credit';
  let payable = 0;
  for (const l of input.lines) {
    const acct = lineAccount(l, 'general_expense');
    const memo = l.description ?? undefined;
    switch (l.vatCode) {
      case 'SR':
        push(out, acct, l.netCents, dr, { vatCode: 'SR', vatRole: 'base', memo });
        push(out, { tag: 'input_vat' }, l.vatCents, dr, { vatCode: 'SR', vatRole: 'tax' });
        payable += l.netCents + l.vatCents;
        break;
      case 'ZR':
      case 'EX':
      case 'OS':
        // Any VAT shown on a non-standard-rated line cannot be reclaimed; it becomes part of the cost.
        push(out, acct, l.netCents + l.vatCents, dr, { vatCode: l.vatCode, vatRole: 'base', memo });
        payable += l.netCents + l.vatCents;
        break;
      case 'BL':
      case 'NC':
        push(out, acct, l.netCents + l.vatCents, dr, { vatCode: l.vatCode, vatRole: 'base', memo });
        payable += l.netCents + l.vatCents;
        break;
      case 'RC': {
        // s.14: the buyer accounts for VAT on the supplier's behalf — output VAT, and input VAT if allowed.
        if (l.vatCents !== 0) throw new PostingError('A reverse-charge line must not include supplier VAT');
        const rc = vatFromNet(l.netCents, input.standardRateBp);
        push(out, acct, l.netCents, dr, { vatCode: 'RC', vatRole: 'base', memo });
        if (input.reverseChargeInputBlocked) {
          push(out, acct, rc, dr, { memo: 'Reverse-charge VAT, input tax blocked' });
        } else {
          push(out, { tag: 'input_vat' }, rc, dr, { vatCode: 'RC', vatRole: 'tax' });
        }
        push(out, { tag: 'output_vat' }, rc, flip(dr), { vatCode: 'RC', vatRole: 'tax' });
        payable += l.netCents;
        break;
      }
    }
  }
  push(out, settlementAccount(input, 'payable'), payable, flip(dr), { contactId: input.contactId });
  return out;
}

function sales(input: PostingInput, sign: 1 | -1): DraftLine[] {
  const out: DraftLine[] = [];
  const cr: 'debit' | 'credit' = sign === 1 ? 'credit' : 'debit';
  let receivable = 0;
  for (const l of input.lines) {
    const tag = SALES_ACCOUNT[l.vatCode];
    if (!tag) throw new PostingError(`VAT code ${l.vatCode} is not valid on a sale`);
    push(out, l.accountId ? { id: l.accountId } : { tag }, l.netCents, cr, { vatCode: l.vatCode, vatRole: 'base', memo: l.description ?? undefined });
    if (l.vatCents !== 0) {
      if (l.vatCode !== 'SR') throw new PostingError(`A ${l.vatCode} sale cannot carry VAT`);
      push(out, { tag: 'output_vat' }, l.vatCents, cr, { vatCode: 'SR', vatRole: 'tax' });
    }
    receivable += l.netCents + l.vatCents;
  }
  push(out, settlementAccount(input, 'receivable'), receivable, flip(cr), { contactId: input.contactId });
  return out;
}

function dailyTakings(input: PostingInput): DraftLine[] {
  const out: DraftLine[] = [];
  const byMethod = new Map<string, number>();
  for (const l of input.lines) {
    const tag = SALES_ACCOUNT[l.vatCode];
    if (!tag) throw new PostingError(`VAT code ${l.vatCode} is not valid on takings`);
    push(out, { tag }, l.netCents, 'credit', { vatCode: l.vatCode, vatRole: 'base' });
    if (l.vatCents !== 0) push(out, { tag: 'output_vat' }, l.vatCents, 'credit', { vatCode: 'SR', vatRole: 'tax' });
    const m = l.paymentMethod ?? 'cash';
    byMethod.set(m, (byMethod.get(m) ?? 0) + l.netCents + l.vatCents);
  }
  for (const [m, amount] of byMethod) {
    const tag = METHOD_ACCOUNT[m];
    if (!tag) throw new PostingError(`Unknown payment method ${m}`);
    push(out, { tag }, amount, 'debit', { contactId: m === 'credit' ? input.contactId : null });
  }
  return out;
}

export function buildPosting(input: PostingInput): DraftLine[] {
  let lines: DraftLine[];
  switch (input.kind) {
    case 'purchase_invoice':
      lines = purchase(input, 1);
      break;
    case 'purchase_credit_note':
      lines = purchase(input, -1);
      break;
    case 'sales_invoice':
      lines = sales(input, 1);
      break;
    case 'sales_credit_note':
      lines = sales(input, -1);
      break;
    case 'daily_takings':
      lines = dailyTakings(input);
      break;
    case 'receipt': {
      lines = [];
      push(lines, settlementAccount({ ...input, settlement: 'cash' }, 'receivable'), input.grossCents, 'debit');
      push(lines, { tag: 'debtors' }, input.grossCents, 'credit', { contactId: input.contactId });
      break;
    }
    case 'payment': {
      lines = [];
      push(lines, { tag: 'creditors' }, input.grossCents, 'debit', { contactId: input.contactId });
      push(lines, settlementAccount({ ...input, settlement: 'cash' }, 'payable'), input.grossCents, 'credit');
      break;
    }
    case 'deposit': {
      // Money received before the invoice: the payment itself is the time of supply, so VAT is due now.
      lines = [];
      push(lines, settlementAccount({ ...input, settlement: 'cash' }, 'receivable'), input.grossCents, 'debit');
      for (const l of input.lines) {
        push(lines, { tag: 'customer_deposits' }, l.netCents, 'credit', { vatCode: l.vatCode, vatRole: 'base', contactId: input.contactId });
        push(lines, { tag: 'output_vat' }, l.vatCents, 'credit', { vatCode: 'SR', vatRole: 'tax' });
      }
      break;
    }
    default:
      throw new PostingError(`${input.kind} entries are written explicitly, not through posting rules`);
  }
  assertBalanced(lines);
  return lines;
}

export function assertBalanced(lines: DraftLine[]): void {
  if (lines.length < 2) throw new PostingError('An entry needs at least two lines');
  const d = lines.reduce((s, l) => s + l.debit, 0);
  const c = lines.reduce((s, l) => s + l.credit, 0);
  if (d !== c) throw new PostingError(`Unbalanced entry: debits ${d}, credits ${c}`);
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit) || l.debit < 0 || l.credit < 0) {
      throw new PostingError('Amounts must be non-negative integer cents');
    }
  }
}

export function reverseLines<T extends { debit: number; credit: number }>(lines: T[]): T[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}
