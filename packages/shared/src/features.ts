/** Screens Nex-Gen can switch on or off per business from the admin console. No override means on. */
export const FEATURE_KEYS = ['opening_balances', 'credit_invoices', 'record_payments', 'invoice_reminders', 'whatsapp_opt_in'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureSet = Record<FeatureKey, boolean>;

export const FEATURES: Record<FeatureKey, { label: string; description: string; default: boolean }> = {
  opening_balances: { label: 'Opening balances', description: 'Cash, bank, stock, who owes what and VAT credit on the start date', default: true },
  credit_invoices: { label: 'Invoices on credit', description: 'Owner raises sales invoices with a due date; they appear in ageing', default: true },
  record_payments: { label: 'Record payments', description: 'Owner records customer receipts and supplier payments against invoices', default: true },
  invoice_reminders: { label: 'Customer invoice reminders', description: 'SMS to customers the day before an invoice falls due', default: true },
  whatsapp_opt_in: { label: 'WhatsApp messages', description: 'Owner can choose WhatsApp for reminders, with recorded consent', default: true },
};

export function resolveFeatures(overrides?: Partial<Record<string, boolean>> | null): FeatureSet {
  const out = {} as FeatureSet;
  for (const k of FEATURE_KEYS) out[k] = typeof overrides?.[k] === 'boolean' ? (overrides[k] as boolean) : FEATURES[k].default;
  return out;
}

export const STAFF_ROLES = ['reviewer', 'senior_reviewer', 'admin', 'support'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
