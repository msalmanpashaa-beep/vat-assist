'use client';
import type { CardCheckoutResponse, PublicPaymentRequest } from '@vat-assist/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { rs } from '@/lib/format';

async function post<T>(token: string, action: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/pay/${token}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? 'That did not work. Try again.');
  return data as T;
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn quiet" style={{ padding: '0.15rem 0.5rem', marginLeft: 8 }}
      onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Card through MIPS or Stripe, or Juice / bank transfer followed by "I've paid". */
export function PayOptions({ token, request }: { token: string; request: PublicPaymentRequest }) {
  const router = useRouter();
  const [zone, setZone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const transfer = request.methods.filter((m) => m.kind === 'juice' || m.kind === 'bank_transfer');

  async function card() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<CardCheckoutResponse>(token, 'card', {});
      if (r.kind === 'redirect') window.location.assign(r.url);
      else setZone(r.html);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function paid(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      let proofDocumentId: string | undefined;
      const file = f.get('proof');
      if (file instanceof File && file.size > 0) {
        const u = await post<{ documentId: string; upload: { url: string; fields: Record<string, string> } }>(token, 'proof-upload', { mimeType: file.type, byteSize: file.size });
        const form = new FormData();
        for (const [k, v] of Object.entries(u.upload.fields)) form.append(k, v);
        form.append('file', file);
        const up = await fetch(u.upload.url, { method: 'POST', body: form });
        if (!up.ok) throw new Error('The screenshot did not upload. Try again or send without it.');
        proofDocumentId = u.documentId;
      }
      await post(token, 'notify', {
        method: f.get('method'), paidOn: f.get('paidOn'),
        payerName: String(f.get('payerName') ?? '').trim() || undefined,
        payerReference: String(f.get('payerReference') ?? '').trim() || undefined,
        proofDocumentId,
      });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <p className="msg err" role="alert">{error}</p>}
      {request.methods.map((m) => {
        if (m.kind === 'card') {
          return (
            <section key="card" className="panel" style={{ marginBottom: '1rem' }}>
              <h2 style={{ marginTop: 0 }}>Pay by card{m.provider === 'mips' ? ' or mobile wallet' : ''}</h2>
              {zone ? (
                <iframe title="Secure payment" srcDoc={zone} sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation" style={{ width: '100%', height: 600, border: 0 }} />
              ) : (
                <button className="btn" onClick={card} disabled={busy}>Pay {rs(request.amountCents)} now</button>
              )}
            </section>
          );
        }
        if (m.kind === 'juice') {
          return (
            <section key="juice" className="panel" style={{ marginBottom: '1rem' }}>
              <h2 style={{ marginTop: 0 }}>Pay with Juice</h2>
              <p>Send {rs(request.amountCents)} to <strong>{m.mobile}</strong><Copy text={m.mobile} />{m.name ? ` (${m.name})` : ''}.</p>
              <p>Write <strong>{request.reference}</strong><Copy text={request.reference} /> in the description.</p>
              {m.qrUrl && <img src={m.qrUrl} alt="QR code to scan with your banking app" style={{ maxWidth: 220 }} />}
            </section>
          );
        }
        return (
          <section key="bank" className="panel" style={{ marginBottom: '1rem' }}>
            <h2 style={{ marginTop: 0 }}>Pay by bank transfer</h2>
            <p>{m.bankName ?? 'Bank'}, account name {m.accountName ?? request.payeeName}</p>
            {m.accountNumber && <p>Account number <strong>{m.accountNumber}</strong><Copy text={m.accountNumber.replace(/\s/g, '')} /></p>}
            {m.iban && <p>IBAN <strong>{m.iban}</strong><Copy text={m.iban} /></p>}
            <p>Reference <strong>{request.reference}</strong><Copy text={request.reference} /></p>
          </section>
        );
      })}
      {transfer.length > 0 && (
        <form onSubmit={paid} className="panel">
          <h2 style={{ marginTop: 0 }}>Already sent the money?</h2>
          <p className="track-label">Tell {request.payeeName}. They confirm once it shows in their account.</p>
          <label className="field">
            How you paid
            <select name="method" defaultValue={transfer[0]!.kind}>
              {transfer.some((m) => m.kind === 'juice') && <option value="juice">Juice</option>}
              {transfer.some((m) => m.kind === 'bank_transfer') && <option value="bank_transfer">Bank transfer</option>}
            </select>
          </label>
          <label className="field">Date sent<input name="paidOn" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label>
          <label className="field">Your name<input name="payerName" autoComplete="name" /></label>
          <label className="field">Transaction number from your bank or Juice (optional)<input name="payerReference" /></label>
          <label className="field">Screenshot of the transfer (optional)<input name="proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
          <button className="btn" disabled={busy}>{busy ? 'Sending…' : 'I have paid'}</button>
        </form>
      )}
    </div>
  );
}
