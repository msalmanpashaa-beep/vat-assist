import type { MeResponse } from '@vat-assist/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';

export default async function OwnerHome() {
  const me = await api<MeResponse>('/me', '/owner');
  if (me.memberships.length === 1) redirect(`/owner/${me.memberships[0]!.orgId}`);
  return (
    <main className="shell">
      <h1>Your businesses</h1>
      {me.memberships.length === 0 ? <p className="lede">Set up your business in the VAT Assist app first.</p> : (
        <ul>{me.memberships.map((m) => <li key={m.orgId}><Link href={`/owner/${m.orgId}`}>{m.orgName}</Link></li>)}</ul>
      )}
    </main>
  );
}
