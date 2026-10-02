import type { AgeingReport } from '@vat-assist/shared';
import { notFound } from 'next/navigation';
import { PaymentForm } from '@/components/owner/PaymentForm';
import { api } from '@/lib/api';
import { rs } from '@/lib/format';

export default async function PaymentPage({ params }: { params: Promise<{ orgId: string; side: string }> }) {
  const { orgId, side } = await params;
  if (side !== 'receive' && side !== 'pay') notFound();
  const back = `/owner/${orgId}/payments/${side}`;
  const report = await api<AgeingReport>(`/orgs/${orgId}/ageing?side=${side === 'receive' ? 'receivable' : 'payable'}`, back);
  const balances = await api<Array<{ tag: string; name: string; balance_cents: number }>>(`/orgs/${orgId}/balances`, back);
  return (
    <main className="shell">
      <h1>{side === 'receive' ? 'A customer paid you' : 'You paid a supplier'}</h1>
      <p className="lede">
        {side === 'receive' ? 'Customers owe' : 'You owe suppliers'} {rs(report.total)} in total. {balances.filter((b) => ['cash', 'bank'].includes(b.tag)).map((b) => `${b.name}: ${rs(b.balance_cents)}`).join(', ')}.
      </p>
      <PaymentForm key={side} orgId={orgId} kind={side === 'receive' ? 'receipt' : 'payment'} contacts={report.contacts} today={new Date().toISOString().slice(0, 10)} />
    </main>
  );
}
