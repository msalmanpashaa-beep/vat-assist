'use client';
import { FEATURE_KEYS, FEATURES, type FeatureKey, type FeatureSet } from '@vat-assist/shared';
import { useState } from 'react';
import { send } from '@/lib/post';
import type { ClientRow } from './ClientAssignments';

export function FeatureFlagsTable({ clients }: { clients: ClientRow[] }) {
  const [flags, setFlags] = useState<Record<string, FeatureSet>>(Object.fromEntries(clients.map((c) => [c.org_id, c.features])));
  const [error, setError] = useState<string | null>(null);

  async function toggle(orgId: string, key: FeatureKey, on: boolean) {
    setError(null);
    try {
      const next = await send<FeatureSet>('PUT', `/admin/orgs/${orgId}/features`, { features: { [key]: on } });
      setFlags({ ...flags, [orgId]: next });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      {error && <p className="msg err" role="alert">{error}</p>}
      <table className="grid">
        <thead>
          <tr><th>Client</th>{FEATURE_KEYS.map((k) => <th key={k} title={FEATURES[k].description}>{FEATURES[k].label}</th>)}</tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.org_id}>
              <td>{c.org_name}</td>
              {FEATURE_KEYS.map((k) => (
                <td key={k}>
                  <input type="checkbox" aria-label={`${FEATURES[k].label} for ${c.org_name}`} checked={flags[c.org_id]?.[k] ?? true} onChange={(e) => toggle(c.org_id, k, e.target.checked)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
