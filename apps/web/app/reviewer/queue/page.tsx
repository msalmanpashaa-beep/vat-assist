import Link from 'next/link';
import { api } from '@/lib/api';
import { flagText, rs, when } from '@/lib/format';

interface Row { document_id: string; org_id: string; org_name: string; status: string; supplier: string | null; invoice_number: string | null; total_cents: number | null; flags: string[]; confidence: number | null; created_at: string }

export default async function Queue() {
  const rows = await api<Row[]>('/reviewer/queue', '/reviewer/queue');
  return (
    <main>
      <h1>Documents to review</h1>
      <p className="lede">Oldest first, across all your clients. Each one stays out of the books until you approve it.</p>
      {rows.length === 0 ? <p className="panel">Nothing is waiting. New uploads that need a decision appear here.</p> : (
        <table className="grid">
          <thead><tr><th>Client</th><th>Supplier</th><th className="num">Total</th><th>Why</th><th>Received</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.document_id}>
                <td>{r.org_name}</td>
                <td><Link href={`/reviewer/clients/${r.org_id}/documents/${r.document_id}`}>{r.supplier ?? 'Unreadable'} {r.invoice_number ?? ''}</Link></td>
                <td className="num">{r.total_cents === null ? '–' : rs(r.total_cents)}</td>
                <td>{r.flags.length ? flagText(r.flags[0]!) : r.status === 'failed' ? 'Could not be read' : `Confidence ${r.confidence}`}</td>
                <td>{when(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
