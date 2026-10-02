'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** A button that POSTs through the proxy and refreshes the page; errors show next to it. */
export function ActionButton({ path, label, confirm, body, variant, then }: { path: string; label: string; confirm?: string; body?: unknown; variant?: 'quiet' | 'danger'; then?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/proxy${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.message ?? `Failed (${res.status})`);
      return;
    }
    const d = await res.json().catch(() => ({}));
    if (then) router.push(then.replace(':returnId', d.returnId ?? ''));
    else router.refresh();
  }
  return (
    <span>
      <button className={`btn ${variant ?? ''}`} onClick={run} disabled={busy}>{busy ? 'Working…' : label}</button>
      {error && <span className="msg err" role="alert" style={{ display: 'inline-block', marginLeft: 8 }}>{error}</span>}
    </span>
  );
}
