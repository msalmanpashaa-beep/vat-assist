import { todayIn } from '@vat-assist/shared';
import { InvoiceForm } from '@/components/owner/InvoiceForm';
import { api } from '@/lib/api';

export default async function NewInvoicePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const contacts = await api<Array<{ id: string; kind: string; name: string; phone_e164: string | null; reminder_consent: boolean }>>(`/orgs/${orgId}/contacts`, `/owner/${orgId}/invoices/new`);
  return (
    <main className="shell">
      <h1>New invoice on credit</h1>
      <p className="lede">The customer pays later. The invoice is recorded straight away and shows in “who owes me” from today.</p>
      <InvoiceForm orgId={orgId} customers={contacts.filter((c) => c.kind !== 'supplier')} today={todayIn('Indian/Mauritius')} />
    </main>
  );
}
