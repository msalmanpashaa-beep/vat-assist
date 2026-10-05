'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { send } from '@/lib/post';

/** Adds a business to the pilot cohort, or takes it out. */
export function CohortButton({ orgId, cohort, inCohort }: { orgId: string; cohort: string; inCohort: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await send('PUT', `/admin/orgs/${orgId}/pilot`, { cohort: inCohort ? null : cohort });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span>
      <button className="btn quiet" disabled={busy} onClick={toggle}>{inCohort ? 'Remove from pilot' : `Add to ${cohort}`}</button>
      {error && <span className="msg err" role="alert">{error}</span>}
    </span>
  );
}
