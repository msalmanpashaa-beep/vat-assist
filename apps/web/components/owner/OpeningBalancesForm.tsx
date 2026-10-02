'use client';
import { buildOpeningBalances, emptyOpeningForm, type OpeningForm } from '@vat-assist/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { day, rs } from '@/lib/format';
import { send } from '@/lib/post';

/** Onboarding step: what the business had on its start date. Blank means "not known"; the reviewer checks it. */
export function OpeningBalancesForm({ orgId, startDate }: { orgId: string; startDate: string }) {
  const router = useRouter();
  const [f, setF] = useState<OpeningForm>(emptyOpeningForm());
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const preview = buildOpeningBalances(f);
  const set = (patch: Partial<OpeningForm>) => setF({ ...f, ...patch });
  const setBank = (i: number, p: Partial<OpeningForm['banks'][number]>) => set({ banks: f.banks.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  const setCustomer = (i: number, p: Partial<OpeningForm['customers'][number]>) => set({ customers: f.customers.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const setSupplier = (i: number, p: Partial<OpeningForm['suppliers'][number]>) => set({ suppliers: f.suppliers.map((c, j) => (j === i ? { ...c, ...p } : c)) });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = buildOpeningBalances(f);
    if (!r.ok) return setErrors(r.errors);
    const { totalAssetsCents: _a, totalOwedCents: _o, ...body } = r.value;
    setBusy(true);
    setErrors([]);
    try {
      await send('POST', `/orgs/${orgId}/opening-balances`, body);
      router.refresh();
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel" aria-label="Opening balances">
      <p className="lede">What the business had on {day(startDate)}. Leave blank what you do not know; your reviewer checks it with you on the call.</p>
      {errors.map((m) => <p key={m} className="msg err" role="alert">{m}</p>)}
      <div className="two">
        <label className="field">Cash in the till and safe (Rs)<input inputMode="decimal" value={f.cash} onChange={(e) => set({ cash: e.target.value })} /></label>
        <label className="field">Stock, estimated at cost (Rs)<input inputMode="decimal" value={f.stock} onChange={(e) => set({ stock: e.target.value })} /></label>
      </div>
      <h2>Bank accounts</h2>
      {f.banks.map((b, i) => (
        <div className="two" key={`b${i}`}>
          <label className="field">Account name<input value={b.name} placeholder="MCB current" onChange={(e) => setBank(i, { name: e.target.value })} /></label>
          <label className="field">Balance (Rs)<input inputMode="decimal" value={b.amount} onChange={(e) => setBank(i, { amount: e.target.value })} /></label>
        </div>
      ))}
      <button type="button" className="btn quiet" onClick={() => set({ banks: [...f.banks, { name: '', amount: '' }] })}>Add a bank account</button>
      <h2>Customers who owe you</h2>
      {f.customers.map((c, i) => (
        <div className="row-grid" key={`c${i}`}>
          <label className="field">Customer name<input value={c.name} onChange={(e) => setCustomer(i, { name: e.target.value })} /></label>
          <label className="field">Amount owed (Rs)<input inputMode="decimal" value={c.amount} onChange={(e) => setCustomer(i, { amount: e.target.value })} /></label>
          <label className="field">Invoice date<input type="date" value={c.date ?? ''} onChange={(e) => setCustomer(i, { date: e.target.value })} /></label>
          <label className="field">Customer mobile<input inputMode="tel" value={c.phone ?? ''} onChange={(e) => setCustomer(i, { phone: e.target.value })} /></label>
        </div>
      ))}
      <button type="button" className="btn quiet" onClick={() => set({ customers: [...f.customers, { name: '', amount: '', date: '', phone: '' }] })}>Add a customer</button>
      <h2>Suppliers you owe</h2>
      {f.suppliers.map((c, i) => (
        <div className="row-grid" key={`s${i}`}>
          <label className="field">Supplier name<input value={c.name} onChange={(e) => setSupplier(i, { name: e.target.value })} /></label>
          <label className="field">Amount you owe (Rs)<input inputMode="decimal" value={c.amount} onChange={(e) => setSupplier(i, { amount: e.target.value })} /></label>
          <label className="field">Bill date<input type="date" value={c.date ?? ''} onChange={(e) => setSupplier(i, { date: e.target.value })} /></label>
        </div>
      ))}
      <button type="button" className="btn quiet" onClick={() => set({ suppliers: [...f.suppliers, { name: '', amount: '', date: '' }] })}>Add a supplier</button>
      <h2>VAT</h2>
      <label className="field">VAT credit carried forward from your last return (Rs)<input inputMode="decimal" value={f.vatCredit} onChange={(e) => set({ vatCredit: e.target.value })} /></label>
      {preview.ok && <p className="track-label">Entered: {rs(preview.value.totalAssetsCents)} the business has or is owed, {rs(preview.value.totalOwedCents)} it owes suppliers.</p>}
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save opening balances'}</button>
    </form>
  );
}
