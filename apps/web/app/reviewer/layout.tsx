import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOut } from '@/components/SignOut';

export default function ReviewerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="topbar">
        <Link className="brand" href="/reviewer">VAT Assist review</Link>
        <Link href="/reviewer">Clients</Link>
        <Link href="/reviewer/queue">Documents to review</Link>
        <SignOut />
      </nav>
      <div className="shell">{children}</div>
    </>
  );
}
