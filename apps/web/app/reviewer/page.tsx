import type { PortfolioRow } from '@vat-assist/shared';
import Link from 'next/link';
import { StageTrack } from '@/components/StageTrack';
import { api } from '@/lib/api';
import { day } from '@/lib/format';

export default async function Portfolio() {
  const rows = await api<PortfolioRow[]>('/reviewer/portfolio', '/reviewer');
  return (
    <main>
      <h1>Your clients</h1>
      <p className="lede">Nearest deadline first. Risk adds up documents waiting for you, open questions, late items and a deadline within a week.</p>
      {rows.length === 0 ? (
        <p className="panel">No clients are assigned to you yet. An admin assigns clients from the admin tools.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr><th>Client</th><th>Period</th><th>Stage</th><th>Due</th><th className="num">To review</th><th className="num">Questions</th><th>Risk</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.orgId}>
                <td><Link href={`/reviewer/clients/${r.orgId}`}>{r.orgName}</Link></td>
                <td>{r.periodLabel ?? '–'}</td>
                <td><StageTrack status={r.periodStatus} /></td>
                <td>{day(r.dueStandard)}</td>
                <td className="num">{r.docsNeedingReview}</td>
                <td className="num">{r.openQueries}</td>
                <td><span className="risk" style={{ width: `${Math.max(4, r.riskScore)}px` }} /> {r.riskScore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
