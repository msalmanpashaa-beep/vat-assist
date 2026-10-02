'use client';
import { type AgedContact, autoAllocate, buildPayment, parseRupees } from '@vat-assist/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { day, rs } from '@/lib/format';
import { send } from '@/lib/post';

type Method = 'cash' | 'bank' | 'juice' | 'card';

/** Apply one payment to one or more open invoices, in full or in part. The ledger and ageing update at once. */
export function PaymentForm({ orgId, kind, contacts, today }: { orgId: string; kind: 'receipt' | 'payment'; contacts: AgedContact[]; today: string }) {
  const router = useRouter();
  const who = contacts.filter((c) => c.contactId && c.items.length);
  const [contactId, setContactId] = useState(who[0]?.contactId ?? '');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>(kind === 'receipt' ? 'cash' : 'bank');
  const [date, setDate] = useState(today);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contact = who.find((c) => c.contactId === contactId);
  const open = (contact?.items ?? []).map((i) => ({ transactionId: i.transactionId, reference: i.reference, issueDate: i.issueDate, outstandingCents: i.outstandingCents }));
  const allocated = Object.values(alloc).reduce((s, v) => s + Math.max(0, parseRupees(v) || 0), 0);
  const paid = Math.max(0, parseRupees(amount) || 0);

  function oldestFirst() {
    setAlloc(Object.fromEntries(autoAllocate(paid, open).map((a) => [a.invoiceId, (a.amountCents / 100).toFixed(2)])));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = buildPayment({ kind, contactId, date, method, amount, allocations: alloc }, open);
    if (!r.ok) return setErrors(r.errors);
    const { unallocatedCents: _u, ...body } = r.value;
    setBusy(true);
    setErrors([]);
    try {
      await send('POST', `/orgs/${orgId}/payments`, body);
      setSaved(`${rs(r.value.amountCents)} recorded ${kind === 'receipt' ? 'from' : 'to'} ${contact?.contactName ?? ''}.`);
      setAmount('');
      setAlloc({});
      router.refresh();
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  if (!who.length) return <p className="panel">{kind === 'receipt' ? 'No customer owes you anything right now.' : 'You do not owe any supplier right now.'}</p>;
  return (
    <form onSubmit={submit} className="panel" aria-label={kind === 'receipt' ? 'Customer payment' : 'Supplier payment'}>
      {saved && <p className="msg ok" role="status">{saved}</p>}
      {errors.map((m) => <p key={m} className="msg err" role="alert">{m}</p>)}
      <div className="row-grid">
        <label className="field">{kind === 'receipt' ? 'Customer' : 'Supplier'}
          <select value={contactId} onChange={(e) => { setContactId(e.target.value); setAlloc({}); }}>
            {who.map((c) => <option key={c.contactId} value={c.contactId ?? ''}>{c.contactName} ({rs(c.total)})</option>)}
          </select>
        </label>
        <label className="field">Amount (Rs)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field">How
          <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            <option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="juice">Juice</option><option value="card">Card</option>
          </select>
        </label>
        <label className="field">Date paid<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      <h2>Which invoices does it pay?</h2>
      <table className="grid">
        <thead><tr><th>Invoice</th><th>Date</th><th className="num">Still owed</th><th className="num">Pay now (Rs)</th></tr></thead>
        <tbody>
          {open.map((i) => (
            <tr key={i.transactionId}>
              <td>{i.reference ?? 'Opening balance'}</td>
              <td>{day(i.issueDate)}</td>
              <td className="num">{rs(i.outstandingCents)}</td>
              <td className="num"><input aria-label={`Pay now on ${i.reference ?? 'opening balance'}`} inputMode="decimal" style={{ width: '8rem', textAlign: 'right' }} value={alloc[i.transactionId] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.transactionId]: e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="row-actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn quiet" onClick={oldestFirst} disabled={!paid}>Oldest first</button>
        <span className="track-label" aria-live="polite">Linked {rs(allocated)}{paid > allocated ? `; not linked to an invoice: ${rs(paid - allocated)}` : ''}</span>
      </p>
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button>
    </form>
  );
}
