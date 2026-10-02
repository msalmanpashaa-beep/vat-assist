import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOut } from '@/components/SignOut';
import { api, ApiError } from '@/lib/api';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try {
    await api('/admin/staff', '/admin');
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      return <main className="shell"><h1>Admins only</h1><p className="lede">This part is for Nex-Gen platform admins.</p></main>;
    }
    throw e;
  }
  return (
    <>
      <nav className="topbar" aria-label="Admin">
        <Link className="brand" href="/admin/staff">VAT Assist admin</Link>
        <Link href="/admin/staff">Staff</Link>
        <Link href="/admin/clients">Clients and reviewers</Link>
        <Link href="/admin/features">Feature flags</Link>
        <Link href="/reviewer">Reviewer console</Link>
        <SignOut />
      </nav>
      <div className="shell">{children}</div>
    </>
  );
}
