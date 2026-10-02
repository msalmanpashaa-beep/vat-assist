import type { FeatureSet } from '@vat-assist/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOut } from '@/components/SignOut';
import { api } from '@/lib/api';

/** Owner navigation. Screens switched off for this business by Nex-Gen are not shown (and the API refuses them). */
export default async function OwnerLayout({ children, params }: { children: ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const f = await api<FeatureSet>(`/orgs/${orgId}/features`, `/owner/${orgId}`);
  const base = `/owner/${orgId}`;
  return (
    <>
      <nav className="topbar" aria-label="Shop">
        <Link className="brand" href={base}>VAT Assist</Link>
        {f.opening_balances && <Link href={`${base}/opening-balances`}>Opening balances</Link>}
        {f.credit_invoices && <Link href={`${base}/invoices/new`}>New invoice</Link>}
        {f.record_payments && <Link href={`${base}/payments/receive`}>Customer paid</Link>}
        {f.record_payments && <Link href={`${base}/payments/pay`}>Pay a supplier</Link>}
        <Link href={`${base}/settings`}>Settings</Link>
        <SignOut />
      </nav>
      {children}
    </>
  );
}
