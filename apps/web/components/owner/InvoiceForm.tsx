'use client';
import { addDaysIso, buildSalesInvoice, invoiceTotals, parseRupees, type VatCodeChoice } from '@vat-assist/shared';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { day, rs } from '@/lib/format';
import { send } from '@/lib/post';

interface Customer { id: string; name: string; phone_e164: string | null; reminder_consent: boolean }
type Line = { description: string; amount: string; vatCode: VatCodeChoice };
const blank = (): Line => ({ description: '', amount: '', vatCode: 'SR' });

export function InvoiceForm({ orgId, customers, today }: { orgId: string; customers: Customer[]; today: string }) {
  const [mode, setMode] = useState<'existing' | 'new'>(customers.length ? 'existing' : 'new');
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDaysIso(today, 30));
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = customers.find((c) => c.id === customerId);
  const totals = invoiceTotals(lines.map((l) => ({ netCents: Math.max(0, parseRupees(l.amount) || 0), vatCode: l.vatCode })));
  const setLine = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = buildSalesInvoice({
      ...(mode === 'existing' ? { customerId } : { customerName: name }),
      customerPhone: phone || undefined, reminderConsent: consent, issueDate, dueDate, lines,
    });
    if (!r.ok) return setErrors(r.errors);
    const { totals: _t, ...body } = r.value;
    setBusy(true);
    setErrors([]);
    try {
      const inv = await send<{ reference: string; grossCents: number; dueDate: string }>('POST', `/orgs/${orgId}/sales-invoices`, body);
      setSaved(`Captured: invoice ${inv.reference} for ${rs(inv.grossCents)}, due ${day(inv.dueDate)}. It is now in your ageing.`);
      setLines([blank()]);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel" aria-label="New invoice">
      {saved && <p className="msg ok" role="status">{saved} <Link href={`/owner/${orgId}`}>Back to overview</Link></p>}
      {errors.map((m) => <p key={m} className="msg err" role="alert">{m}</p>)}
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="track-label">Customer</legend>
        <label className="switch"><input type="radio" name="mode" checked={mode === 'existing'} onChange={() => setMode('existing')} disabled={!customers.length} /> Existing customer</label>
        <label className="switch"><input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} /> New customer</label>
      </fieldset>
      {mode === 'existing' ? (
        <label className="field">Customer
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      ) : (
        <label className="field">Customer name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      )}
      <div className="two">
        <label className="field">Customer mobile, for reminders<input inputMode="tel" value={phone} placeholder={chosen?.phone_e164 ?? '5712 3456'} onChange={(e) => setPhone(e.target.value)} /></label>
        <label className="switch" style={{ alignSelf: 'end' }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> The customer agreed to SMS reminders{chosen?.reminder_consent ? ' (already agreed)' : ''}</label>
      </div>
      <div className="two">
        <label className="field">Invoice date<input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></label>
        <label className="field">Due date<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
      </div>
      <h2>Lines</h2>
      {lines.map((l, i) => (
        <div className="row-grid" key={i}>
          <label className="field">Item or service<input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></label>
          <label className="field">Amount before VAT (Rs)<input inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></label>
          <label className="field">VAT
            <select value={l.vatCode} onChange={(e) => setLine(i, { vatCode: e.target.value as VatCodeChoice })}>
              <option value="SR">15%</option><option value="ZR">Zero-rated</option><option value="EX">Exempt</option><option value="OS">Outside scope</option>
            </select>
          </label>
        </div>
      ))}
      <button type="button" className="btn quiet" onClick={() => setLines([...lines, blank()])}>Add a line</button>
      <p style={{ fontSize: '1.2rem', fontWeight: 700 }} aria-live="polite">Total {rs(totals.grossCents)}, of which VAT {rs(totals.vatCents)}</p>
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save invoice'}</button>
    </form>
  );
}
