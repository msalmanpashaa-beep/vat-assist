'use client';
import { type FeatureSet, STAFF_ROLES } from '@vat-assist/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { send } from '@/lib/post';
import type { StaffRow } from './StaffAdmin';

export interface ClientRow {
  org_id: string; org_name: string; legal_name: string; vat_number: string | null;
  staff: Array<{ userId: string; name: string; email: string; role: string }>; features: FeatureSet;
}

/** Assign and unassign reviewers per client, or move many clients to another reviewer at once. */
export function ClientAssignments({ clients, staff }: { clients: ClientRow[]; staff: StaffRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [pick, setPick] = useState<Record<string, { userId: string; role: string }>>({});
  const [bulk, setBulk] = useState({ toUserId: staff[0]?.user_id ?? '', role: 'reviewer', fromUserId: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await work() });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const name = (id: string) => staff.find((s) => s.user_id === id)?.full_name ?? 'staff member';
  return (
    <div>
      {msg && <p className={`msg ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <div className="panel" style={{ marginBottom: '1rem' }} aria-label="Bulk reassign">
        <strong>Move {selected.length} selected client(s)</strong>
        <div className="row-grid">
          <label className="field">To
            <select value={bulk.toUserId} onChange={(e) => setBulk({ ...bulk, toUserId: e.target.value })}>
              {staff.map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name ?? s.email}</option>)}
            </select>
          </label>
          <label className="field">As
            <select value={bulk.role} onChange={(e) => setBulk({ ...bulk, role: e.target.value })}>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
            </select>
          </label>
          <label className="field">Replacing (optional)
            <select value={bulk.fromUserId} onChange={(e) => setBulk({ ...bulk, fromUserId: e.target.value })}>
              <option value="">Nobody, just add</option>
              {staff.map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name ?? s.email}</option>)}
            </select>
          </label>
        </div>
        <button className="btn" disabled={busy || !selected.length || !bulk.toUserId} onClick={() => run(async () => {
          await send('POST', '/admin/assignments/bulk', { orgIds: selected, toUserId: bulk.toUserId, role: bulk.role, ...(bulk.fromUserId ? { fromUserId: bulk.fromUserId } : {}) });
          const n = selected.length;
          setSelected([]);
          return `${n} client(s) moved to ${name(bulk.toUserId)}.`;
        })}>Reassign selected</button>
      </div>
      <table className="grid">
        <thead><tr><th><span className="track-label">Select</span></th><th>Client</th><th>Assigned</th><th>Add</th></tr></thead>
        <tbody>
          {clients.map((c) => {
            const p = pick[c.org_id] ?? { userId: staff[0]?.user_id ?? '', role: 'reviewer' };
            return (
              <tr key={c.org_id}>
                <td><input type="checkbox" aria-label={`Select ${c.org_name}`} checked={selected.includes(c.org_id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.org_id] : selected.filter((x) => x !== c.org_id))} /></td>
                <td>{c.org_name}<div className="track-label">{c.legal_name}, VAT {c.vat_number ?? '–'}</div></td>
                <td>
                  {c.staff.length === 0 && <span className="track-label">Nobody yet</span>}
                  {c.staff.map((s) => (
                    <span className="chip" key={`${s.userId}-${s.role}`}>
                      {s.name} ({s.role.replace('_', ' ')})
                      <button aria-label={`Remove ${s.name} from ${c.org_name}`} disabled={busy} onClick={() => run(async () => {
                        await send('DELETE', `/admin/orgs/${c.org_id}/staff/${s.userId}`);
                        return `${s.name} removed from ${c.org_name}.`;
                      })}>×</button>
                    </span>
                  ))}
                </td>
                <td>
                  <div className="row-actions">
                    <select aria-label={`Staff for ${c.org_name}`} value={p.userId} onChange={(e) => setPick({ ...pick, [c.org_id]: { ...p, userId: e.target.value } })}>
                      {staff.map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name ?? s.email}</option>)}
                    </select>
                    <select aria-label={`Role for ${c.org_name}`} value={p.role} onChange={(e) => setPick({ ...pick, [c.org_id]: { ...p, role: e.target.value } })}>
                      {STAFF_ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                    </select>
                    <button className="btn quiet" disabled={busy || !p.userId} onClick={() => run(async () => {
                      await send('POST', `/admin/orgs/${c.org_id}/staff`, p);
                      return `${name(p.userId)} assigned to ${c.org_name}.`;
                    })}>Assign</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
