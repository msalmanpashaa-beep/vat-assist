import type { OpeningBalancesInput, PaymentInput, SalesInvoiceInput } from './contracts';
import { STAFF_ROLES, type StaffRole } from './features';
import type { IsoDate } from './dates';
import { vatFromNet } from './vat';

/**
 * Screen logic shared by the phone app and the web console: turn what the person typed into the exact
 * API request, or a list of plain-language problems. Pure functions, unit-tested once for both apps.
 */
export type FormResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** "1,234.50" → 123450; "12,5" (French) → 1250; blank → null; anything else → NaN. */
export function parseRupees(input: string | null | undefined): number | null {
  let t = (input ?? '').trim().replace(/\s/g, '').replace(/^Rs\.?/i, '');
  if (!t) return null;
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else t = t.replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

/** Mauritian mobiles are 8 digits starting with 5: "5712 3456" → "+23057123456". */
export function normaliseMuPhone(input: string | null | undefined): string | null {
  const d = (input ?? '').replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(d)) return d;
  if (/^00[1-9]\d{6,14}$/.test(d)) return `+${d.slice(2)}`;
  if (/^5\d{7}$/.test(d)) return `+230${d}`;
  if (/^2305\d{7}$/.test(d)) return `+${d}`;
  return null;
}

// ---------- opening balances ----------

export interface OpeningForm {
  cash: string;
  stock: string;
  vatCredit: string;
  banks: Array<{ name: string; amount: string }>;
  customers: Array<{ name: string; amount: string; date?: string; phone?: string }>;
  suppliers: Array<{ name: string; amount: string; date?: string }>;
}

export function emptyOpeningForm(): OpeningForm {
  return { cash: '', stock: '', vatCredit: '', banks: [{ name: '', amount: '' }], customers: [], suppliers: [] };
}

export function buildOpeningBalances(f: OpeningForm): FormResult<OpeningBalancesInput & { totalAssetsCents: number; totalOwedCents: number }> {
  const errors: string[] = [];
  const money = (label: string, s: string) => {
    const c = parseRupees(s);
    if (c !== null && Number.isNaN(c)) errors.push(`${label}: enter an amount like 1,250.00`);
    return c !== null && !Number.isNaN(c) ? c : 0;
  };
  const cash = money('Cash', f.cash);
  const stock = money('Stock', f.stock);
  const vatCredit = money('VAT credit', f.vatCredit);
  const banks = f.banks
    .filter((b) => b.name.trim() || b.amount.trim())
    .map((b, i) => {
      if (!b.name.trim()) errors.push(`Bank ${i + 1}: name the account, e.g. MCB current`);
      return { name: b.name.trim(), amountCents: money(`Bank ${b.name || i + 1}`, b.amount) };
    });
  const people = <T extends { name: string; amount: string; date?: string }>(rows: T[], who: string) =>
    rows
      .filter((r) => r.name.trim() || r.amount.trim())
      .map((r, i) => {
        if (!r.name.trim()) errors.push(`${who} ${i + 1}: name is missing`);
        const amountCents = money(`${who} ${r.name || i + 1}`, r.amount);
        if (amountCents <= 0) errors.push(`${who} ${r.name || i + 1}: amount must be more than zero`);
        if (r.date && !isDate(r.date)) errors.push(`${who} ${r.name || i + 1}: date must be YYYY-MM-DD`);
        return { r, amountCents };
      });
  const customers = people(f.customers, 'Customer').map(({ r, amountCents }) => {
    const phone = r.phone?.trim() ? normaliseMuPhone(r.phone) : null;
    if (r.phone?.trim() && !phone) errors.push(`Customer ${r.name}: mobile number not recognised`);
    return { name: r.name.trim(), amountCents, ...(r.date ? { date: r.date } : {}), ...(phone ? { phone } : {}) };
  });
  const suppliers = people(f.suppliers, 'Supplier').map(({ r, amountCents }) => ({ name: r.name.trim(), amountCents, ...(r.date ? { date: r.date } : {}) }));
  if (errors.length) return { ok: false, errors };
  const totalAssetsCents = cash + stock + vatCredit + banks.reduce((s, b) => s + b.amountCents, 0) + customers.reduce((s, c) => s + c.amountCents, 0);
  return {
    ok: true,
    value: {
      cashInHandCents: cash, bankBalances: banks, stockCents: stock, customersOwe: customers, suppliersOwed: suppliers,
      vatCreditCarriedForwardCents: vatCredit, totalAssetsCents, totalOwedCents: suppliers.reduce((s, x) => s + x.amountCents, 0),
    },
  };
}

// ---------- sales invoice on credit ----------

export type VatCodeChoice = 'SR' | 'ZR' | 'EX' | 'OS';

export interface InvoiceForm {
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  reminderConsent: boolean;
  issueDate: string;
  dueDate: string;
  lines: Array<{ description: string; amount: string; vatCode: VatCodeChoice }>;
}

export function invoiceTotals(lines: Array<{ netCents: number; vatCode: VatCodeChoice }>, standardRateBp = 1500) {
  let netCents = 0;
  let vatCents = 0;
  for (const l of lines) {
    netCents += l.netCents;
    if (l.vatCode === 'SR') vatCents += vatFromNet(l.netCents, standardRateBp);
  }
  return { netCents, vatCents, grossCents: netCents + vatCents };
}

export function buildSalesInvoice(f: InvoiceForm, standardRateBp = 1500): FormResult<SalesInvoiceInput & { totals: ReturnType<typeof invoiceTotals> }> {
  const errors: string[] = [];
  if (!f.customerId && !f.customerName?.trim()) errors.push('Choose a customer or type a new name');
  const phone = f.customerPhone?.trim() ? normaliseMuPhone(f.customerPhone) : null;
  if (f.customerPhone?.trim() && !phone) errors.push('Customer mobile not recognised (e.g. 5712 3456)');
  if (f.reminderConsent && !phone && !f.customerId) errors.push('Reminders need the customer’s mobile number');
  if (!isDate(f.issueDate)) errors.push('Invoice date must be YYYY-MM-DD');
  if (!isDate(f.dueDate)) errors.push('Due date must be YYYY-MM-DD');
  else if (isDate(f.issueDate) && f.dueDate < f.issueDate) errors.push('The due date is before the invoice date');
  const lines = f.lines
    .filter((l) => l.description.trim() || l.amount.trim())
    .map((l, i) => {
      const netCents = parseRupees(l.amount);
      if (!l.description.trim()) errors.push(`Line ${i + 1}: describe the item or service`);
      if (netCents === null || Number.isNaN(netCents) || netCents <= 0) errors.push(`Line ${i + 1}: enter the amount before VAT`);
      return { description: l.description.trim(), netCents: netCents && !Number.isNaN(netCents) ? netCents : 0, vatCode: l.vatCode };
    });
  if (!lines.length) errors.push('Add at least one line');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...(f.customerId ? { customerId: f.customerId } : { customerName: f.customerName!.trim() }),
      ...(phone ? { customerPhone: phone } : {}),
      ...(f.reminderConsent ? { customerReminderConsent: true } : {}),
      issueDate: f.issueDate,
      settlement: { mode: 'credit', dueDate: f.dueDate },
      lines,
      totals: invoiceTotals(lines, standardRateBp),
    },
  };
}

// ---------- payments against open invoices ----------

export interface OpenInvoice { transactionId: string; reference: string | null; issueDate: IsoDate; outstandingCents: number }

/** Spread a payment over the oldest invoices first; whatever is left stays unallocated on the account. */
export function autoAllocate(amountCents: number, items: OpenInvoice[]): Array<{ invoiceId: string; amountCents: number }> {
  let left = Math.max(0, amountCents);
  const out: Array<{ invoiceId: string; amountCents: number }> = [];
  for (const i of [...items].sort((a, b) => a.issueDate.localeCompare(b.issueDate) || (a.reference ?? '').localeCompare(b.reference ?? ''))) {
    if (left <= 0) break;
    const take = Math.min(left, i.outstandingCents);
    if (take > 0) out.push({ invoiceId: i.transactionId, amountCents: take });
    left -= take;
  }
  return out;
}

export interface PaymentForm {
  kind: 'receipt' | 'payment';
  contactId: string;
  date: string;
  method: 'cash' | 'bank' | 'juice' | 'card';
  amount: string;
  allocations: Record<string, string>;
}

export function buildPayment(f: PaymentForm, open: OpenInvoice[]): FormResult<PaymentInput & { unallocatedCents: number }> {
  const errors: string[] = [];
  if (!f.contactId) errors.push(f.kind === 'receipt' ? 'Choose the customer' : 'Choose the supplier');
  if (!isDate(f.date)) errors.push('Date must be YYYY-MM-DD');
  const amount = parseRupees(f.amount);
  if (amount === null || Number.isNaN(amount) || amount <= 0) errors.push('Enter the amount paid');
  const byId = new Map(open.map((o) => [o.transactionId, o]));
  const allocations: Array<{ invoiceId: string; amountCents: number }> = [];
  for (const [invoiceId, text] of Object.entries(f.allocations)) {
    const c = parseRupees(text);
    if (c === null || c === 0) continue;
    const inv = byId.get(invoiceId);
    if (!inv) errors.push('An invoice in the list is no longer open; reload');
    else if (Number.isNaN(c) || c < 0) errors.push(`${inv.reference ?? 'Invoice'}: amount not recognised`);
    else if (c > inv.outstandingCents) errors.push(`${inv.reference ?? 'Invoice'}: only ${(inv.outstandingCents / 100).toFixed(2)} is left to pay`);
    else allocations.push({ invoiceId, amountCents: c });
  }
  const allocated = allocations.reduce((s, a) => s + a.amountCents, 0);
  if (amount && !Number.isNaN(amount) && allocated > amount) errors.push('More is allocated to invoices than was paid');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { kind: f.kind, contactId: f.contactId, date: f.date, method: f.method, amountCents: amount as number, allocations, unallocatedCents: (amount as number) - allocated },
  };
}

// ---------- staff ----------

export function validateStaffInvite(i: { email: string; fullName: string; role: string }): string[] {
  const errors: string[] = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email.trim())) errors.push('Enter a valid email address');
  if (i.fullName.trim().length < 2) errors.push('Enter the person’s name');
  if (!STAFF_ROLES.includes(i.role as StaffRole)) errors.push('Choose a role');
  return errors;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
