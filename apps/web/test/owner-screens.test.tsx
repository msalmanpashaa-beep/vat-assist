import './helpers';
import { type AgedContact, resolveFeatures, WHATSAPP_CONSENT } from '@vat-assist/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InvoiceForm } from '@/components/owner/InvoiceForm';
import { OpeningBalancesForm } from '@/components/owner/OpeningBalancesForm';
import { PaymentForm } from '@/components/owner/PaymentForm';
import { SettingsForm } from '@/components/owner/SettingsForm';
import { calls, mockApi, router } from './helpers';

afterEach(cleanup);
const type = (label: string, value: string, index = 0) => fireEvent.change(screen.getAllByLabelText(label)[index]!, { target: { value } });

describe('Opening balances screen', () => {
  it('sends what the owner typed, in cents, and refreshes to show the saved summary', async () => {
    mockApi(() => ({ entryNo: 1, openItems: 1 }));
    render(<OpeningBalancesForm orgId="o1" startDate="2026-07-01" />);
    type('Cash in the till and safe (Rs)', '15,000');
    type('Account name', 'MCB current');
    type('Balance (Rs)', '250,000');
    fireEvent.click(screen.getByText('Add a customer'));
    type('Customer name', 'Hotel Demo Ltd');
    type('Amount owed (Rs)', '1,200');
    type('Customer mobile', '5710 0021');
    type('VAT credit carried forward from your last return (Rs)', '1,200.50');
    fireEvent.submit(screen.getByRole('form', { name: 'Opening balances' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: '/api/proxy/orgs/o1/opening-balances', method: 'POST',
      body: {
        cashInHandCents: 1_500_000, bankBalances: [{ name: 'MCB current', amountCents: 25_000_000 }],
        customersOwe: [{ name: 'Hotel Demo Ltd', amountCents: 120_000, phone: '+23057100021' }], vatCreditCarriedForwardCents: 120_050,
      },
    });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('explains problems instead of saving', () => {
    mockApi();
    render(<OpeningBalancesForm orgId="o1" startDate="2026-07-01" />);
    type('Balance (Rs)', '100');
    fireEvent.submit(screen.getByRole('form', { name: 'Opening balances' }));
    expect(screen.getByRole('alert').textContent).toMatch(/name the account/);
    expect(calls).toHaveLength(0);
  });
});

describe('Credit invoice screen', () => {
  it('shows the VAT-inclusive total as you type and saves a credit invoice with due date and reminder consent', async () => {
    mockApi(() => ({ reference: 'INV-00007', grossCents: 460_000, dueDate: '2026-11-01' }));
    render(<InvoiceForm orgId="o1" customers={[]} today="2026-10-02" />);
    type('Customer name', 'Hotel Demo Ltd');
    type('Customer mobile, for reminders', '5710 0021');
    fireEvent.click(screen.getByLabelText(/The customer agreed to SMS reminders/));
    type('Item or service', 'Catering supplies');
    type('Amount before VAT (Rs)', '4,000');
    expect(screen.getByText('Total Rs 4,600.00, of which VAT Rs 600.00')).toBeTruthy();
    fireEvent.submit(screen.getByRole('form', { name: 'New invoice' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: '/api/proxy/orgs/o1/sales-invoices',
      body: {
        customerName: 'Hotel Demo Ltd', customerPhone: '+23057100021', customerReminderConsent: true, issueDate: '2026-10-02',
        settlement: { mode: 'credit', dueDate: '2026-11-01' }, lines: [{ description: 'Catering supplies', netCents: 400_000, vatCode: 'SR' }],
      },
    });
    expect((await screen.findByRole('status')).textContent).toMatch(/Captured: invoice INV-00007 for Rs 4,600.00, due 01\/11\/2026\. It is now in your ageing\./);
  });
});

describe('Payment screens', () => {
  const hotel: AgedContact = {
    contactId: 'c1', contactName: 'Hotel Demo Ltd', total: 580_000, buckets: { '0-30': 460_000, '31-60': 0, '61-90': 0, '90+': 120_000 },
    items: [
      { transactionId: 't-open', contactId: 'c1', contactName: 'Hotel Demo Ltd', reference: null, issueDate: '2026-05-10', dueDate: null, outstandingCents: 120_000, days: 145, bucket: '90+' },
      { transactionId: 't-inv', contactId: 'c1', contactName: 'Hotel Demo Ltd', reference: 'INV-00001', issueDate: '2026-10-02', dueDate: '2026-11-01', outstandingCents: 460_000, days: 0, bucket: '0-30' },
    ],
  };

  it('customer payment: "oldest first" fills the allocations; partial payment of the newer invoice', async () => {
    mockApi(() => ({ transactionId: 'r1' }));
    render(<PaymentForm orgId="o1" kind="receipt" contacts={[hotel]} today="2026-10-02" />);
    type('Amount (Rs)', '3,200');
    fireEvent.change(screen.getByLabelText('How'), { target: { value: 'juice' } });
    fireEvent.click(screen.getByText('Oldest first'));
    expect((screen.getByLabelText('Pay now on opening balance') as HTMLInputElement).value).toBe('1200.00');
    expect((screen.getByLabelText('Pay now on INV-00001') as HTMLInputElement).value).toBe('2000.00');
    fireEvent.submit(screen.getByRole('form', { name: 'Customer payment' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: '/api/proxy/orgs/o1/payments',
      body: { kind: 'receipt', contactId: 'c1', method: 'juice', amountCents: 320_000, allocations: [{ invoiceId: 't-open', amountCents: 120_000 }, { invoiceId: 't-inv', amountCents: 200_000 }] },
    });
  });

  it('supplier payment: defaults to bank and refuses paying more than is owed on a bill', () => {
    mockApi();
    render(<PaymentForm orgId="o1" kind="payment" contacts={[{ ...hotel, contactName: 'Grossiste Demo Ltd' }]} today="2026-10-02" />);
    expect((screen.getByLabelText('How') as HTMLSelectElement).value).toBe('bank');
    type('Amount (Rs)', '5,000');
    type('Pay now on opening balance', '1,500');
    fireEvent.submit(screen.getByRole('form', { name: 'Supplier payment' }));
    expect(screen.getByRole('alert').textContent).toMatch(/only 1200.00 is left/);
    expect(calls).toHaveLength(0);
  });
});

describe('Settings screen', () => {
  const settings = { debtorRemindersEnabled: false, scheduledInvoiceReminders: 0, whatsappOptIn: false, whatsappConsentVersion: null, currentConsentVersion: WHATSAPP_CONSENT.version };

  it('turning reminders on schedules them; WhatsApp consent sends the wording version', async () => {
    mockApi((url) => (url.endsWith('/settings') ? { scheduled: 2, cancelled: 0 } : { whatsappOptIn: true }));
    render(<SettingsForm orgId="o1" settings={settings} features={resolveFeatures(null)} scheduled={[]} />);
    fireEvent.click(screen.getByLabelText(/Text customers the day before/));
    expect((await screen.findByRole('status')).textContent).toBe('Reminders on: 2 reminder(s) scheduled.');
    expect(calls[0]).toMatchObject({ url: '/api/proxy/orgs/o1/settings', method: 'PATCH', body: { debtorRemindersEnabled: true } });
    fireEvent.click(screen.getByText('I agree, use WhatsApp'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ url: '/api/proxy/orgs/o1/whatsapp-consent', body: { optIn: true, consentVersion: WHATSAPP_CONSENT.version } });
  });

  it('hides both toggles when Nex-Gen has switched them off for the business', () => {
    render(<SettingsForm orgId="o1" settings={settings} features={resolveFeatures({ invoice_reminders: false, whatsapp_opt_in: false })} scheduled={[]} />);
    expect(screen.queryByLabelText(/Text customers the day before/)).toBeNull();
    expect(screen.queryByText('I agree, use WhatsApp')).toBeNull();
  });
});
