import type { Tx } from '../../db/db.service';

/** Default chart for a small Mauritian shop. system_tag is how posting rules find an account. */
export const CHART_TEMPLATE = [
  { code: '1000', name: 'Cash in hand', type: 'asset', tag: 'cash' },
  { code: '1010', name: 'Bank', type: 'asset', tag: 'bank' },
  { code: '1020', name: 'Juice receipts (clearing)', type: 'asset', tag: 'juice_clearing' },
  { code: '1030', name: 'Card receipts (clearing)', type: 'asset', tag: 'card_clearing' },
  { code: '1040', name: 'Online payments (clearing)', type: 'asset', tag: 'stripe_clearing' },
  { code: '1050', name: 'MIPS payments (clearing)', type: 'asset', tag: 'mips_clearing' },
  { code: '1100', name: 'Customers (debtors)', type: 'asset', tag: 'debtors' },
  { code: '1200', name: 'Stock', type: 'asset', tag: 'stock' },
  { code: '1300', name: 'Equipment', type: 'asset', tag: 'equipment' },
  { code: '1400', name: 'Input VAT', type: 'asset', tag: 'input_vat' },
  { code: '2000', name: 'Suppliers (creditors)', type: 'liability', tag: 'creditors' },
  { code: '2100', name: 'Output VAT', type: 'liability', tag: 'output_vat' },
  { code: '2110', name: 'VAT payable to MRA', type: 'liability', tag: 'vat_payable' },
  { code: '2200', name: 'Customer deposits', type: 'liability', tag: 'customer_deposits' },
  { code: '3000', name: "Owner's capital", type: 'equity', tag: 'owner_capital' },
  { code: '3010', name: 'Drawings (personal)', type: 'equity', tag: 'drawings' },
  { code: '3900', name: 'Opening balances', type: 'equity', tag: 'opening_equity' },
  { code: '4000', name: 'Sales — standard-rated', type: 'income', tag: 'sales_sr' },
  { code: '4010', name: 'Sales — zero-rated', type: 'income', tag: 'sales_zr' },
  { code: '4020', name: 'Sales — exempt', type: 'income', tag: 'sales_ex' },
  { code: '4030', name: 'Sales — outside scope', type: 'income', tag: 'sales_os' },
  { code: '4100', name: 'Service revenue', type: 'income', tag: 'service_revenue' },
  { code: '5000', name: 'Purchases for resale', type: 'expense', tag: 'purchases' },
  { code: '6000', name: 'Rent', type: 'expense', tag: 'rent' },
  { code: '6010', name: 'Electricity and water', type: 'expense', tag: 'utilities' },
  { code: '6020', name: 'Wages', type: 'expense', tag: 'wages' },
  { code: '6030', name: 'Transport', type: 'expense', tag: 'transport' },
  { code: '6040', name: 'Telephone and internet', type: 'expense', tag: 'telecom' },
  { code: '6050', name: 'Bank and payment charges', type: 'expense', tag: 'bank_charges' },
  { code: '6060', name: 'Repairs', type: 'expense', tag: 'repairs' },
  { code: '6070', name: 'Motor expenses', type: 'expense', tag: 'motor_expenses' },
  { code: '6080', name: 'Meals and entertainment', type: 'expense', tag: 'entertainment' },
  { code: '6900', name: 'Other expenses', type: 'expense', tag: 'general_expense' },
] as const;

export async function installChart(tx: Tx, orgId: string): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [orgId];
  CHART_TEMPLATE.forEach((a, i) => {
    const b = i * 4;
    values.push(`($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`);
    params.push(a.code, a.name, a.type, a.tag);
  });
  await tx.exec(
    `insert into accounts (org_id, code, name, type, system_tag) values ${values.join(',')} on conflict (org_id, code) do nothing`,
    params,
  );
}
