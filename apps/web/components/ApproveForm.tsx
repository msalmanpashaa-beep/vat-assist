'use client';
import { CATEGORY_LABELS, PURCHASE_CATEGORY_KEYS } from '@vat-assist/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

interface Initial {
  supplierName: string | null;
  supplierVatNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  netCents: number | null;
  vatCents: number | null;
  category: string | null;
}

const toRs = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2));
const toCents = (s: string) => Math.round(Number(s.replace(/[,\s]/g, '')) * 100);

/** Reviewer corrections: only fields that change are sent; the original reading stays in the audit trail. */
export function ApproveForm({ orgId, docId, initial }: { orgId: string; docId: string; initial: Initial }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const c: Record<string, unknown> = {};
    const text = (k: keyof Initial) => {
      const v = String(f.get(k) ?? '').trim();
      if (v && v !== (initial[k] ?? '')) c[k] = v;
    };
    text('supplierName'); text('supplierVatNumber'); text('invoiceNumber'); text('invoiceDate'); text('category');
    for (const k of ['netCents', 'vatCents'] as const) {
      const v = String(f.get(k) ?? '').trim();
      if (v && toCents(v) !== initial[k]) c[k] = toCents(v);
    }
    const lateReason = String(f.get('lateReason') ?? '').trim();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/proxy/orgs/${orgId}/documents/${docId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ corrections: c, ...(lateReason ? { lateReason } : {}), treatExpiredClaimAsCost: f.get('expired') === 'on' }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `Failed (${res.status})`);
      return;
    }
    router.push(`/reviewer/clients/${orgId}`);
  }

  return (
    <form onSubmit={submit} className="panel">
      {error && <p className="msg err" role="alert">{error}</p>}
      <label className="field">Supplier<input name="supplierName" defaultValue={initial.supplierName ?? ''} /></label>
      <label className="field">Supplier VAT number<input name="supplierVatNumber" defaultValue={initial.supplierVatNumber ?? ''} pattern="\d{8}" /></label>
      <label className="field">Invoice number<input name="invoiceNumber" defaultValue={initial.invoiceNumber ?? ''} /></label>
      <label className="field">Invoice date<input name="invoiceDate" type="date" defaultValue={initial.invoiceDate ?? ''} /></label>
      <div className="two">
        <label className="field">Amount before VAT (Rs)<input name="netCents" inputMode="decimal" defaultValue={toRs(initial.netCents)} /></label>
        <label className="field">VAT (Rs)<input name="vatCents" inputMode="decimal" defaultValue={toRs(initial.vatCents)} /></label>
      </div>
      <label className="field">
        What it is for
        <select name="category" defaultValue={initial.category ?? ''}>
          <option value="">Keep the owner’s answer</option>
          {PURCHASE_CATEGORY_KEYS.map((k) => <option key={k} value={k}>{CATEGORY_LABELS.en[k]}</option>)}
        </select>
      </label>
      <label className="field">Reason, if this belongs to a closed period<input name="lateReason" placeholder="Supplier sent the invoice late" /></label>
      <label style={{ display: 'flex', gap: 8, marginBottom: 12 }}><input type="checkbox" name="expired" /> If the VAT claim window has passed, record the VAT as a cost</label>
      <button className="btn" disabled={busy}>{busy ? 'Posting…' : 'Approve and post'}</button>
    </form>
  );
}
