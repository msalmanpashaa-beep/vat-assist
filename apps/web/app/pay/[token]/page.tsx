import type { PublicPaymentRequest } from '@vat-assist/shared';
import type { Metadata } from 'next';
import { PayOptions } from '@/components/PayOptions';
import { day, rs } from '@/lib/format';
import { API_URL } from '@/lib/session';

export const metadata: Metadata = { title: 'Pay', robots: { index: false, follow: false } };

export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const { done } = await searchParams;
  const res = await fetch(`${API_URL}/pay/${encodeURIComponent(token)}`, { cache: 'no-store' }).catch(() => null);
  if (!res || res.status >= 500) {
    return (
      <main className="shell" style={{ maxWidth: 560, paddingTop: '10vh' }}>
        <h1>Payments are unavailable for a moment</h1>
        <p className="lede">Nothing has been charged. Try this link again in a few minutes.</p>
      </main>
    );
  }
  if (!res.ok) {
    return (
      <main className="shell" style={{ maxWidth: 560, paddingTop: '10vh' }}>
        <h1>This payment link does not work</h1>
        <p className="lede">It may be mistyped or withdrawn. Ask the business to send it again.</p>
      </main>
    );
  }
  const r = (await res.json()) as PublicPaymentRequest;
  return (
    <main className="shell" style={{ maxWidth: 560, paddingTop: '6vh' }}>
      <p className="track-label">{r.payeeName}</p>
      <h1>{rs(r.amountCents)}</h1>
      <p className="lede">{r.description}. Reference <strong>{r.reference}</strong>{r.status === 'open' ? `, valid until ${day(r.expiresAt.slice(0, 10))}` : ''}.</p>
      {r.status === 'paid' && <p className="msg ok">Paid. Thank you.</p>}
      {r.status === 'expired' && <p className="msg err">This link has expired. Ask {r.payeeName} for a new one.</p>}
      {r.status === 'cancelled' && <p className="msg err">This request was withdrawn.</p>}
      {r.status === 'open' && done && <p className="msg ok">Thank you. We are confirming your payment; this page will show “Paid” once it clears.</p>}
      {r.status === 'open' && r.pendingConfirmation && <p className="msg ok">You told {r.payeeName} you have paid. They will confirm when they see the money.</p>}
      {r.status === 'open' && !r.pendingConfirmation && <PayOptions token={token} request={r} />}
    </main>
  );
}
