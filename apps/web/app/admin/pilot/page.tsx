import { CohortButton } from '@/components/admin/CohortButton';
import { type PilotScore, PilotScorecard } from '@/components/admin/PilotScorecard';
import { api } from '@/lib/api';
import { day, when } from '@/lib/format';

interface PilotShop {
  orgId: string; orgName: string; cohort: string | null; signedUpAt: string;
  activation: { activated: boolean; missing: string[] }; reviewerMinutes: number;
  filing: { due: number; onTime: number; late: string[] }; churned: boolean; lastOwnerActivity: string | null; referrals: number;
}
interface PilotData { cohort: string | null; quarter: { label: string; startsOn: string; endsOn: string }; scorecard: PilotScore; shops: PilotShop[] }

export default async function PilotPage({ searchParams }: { searchParams: Promise<{ cohort?: string; quarter?: string; view?: string }> }) {
  const sp = await searchParams;
  const cohort = sp.cohort?.trim() || 'pilot-1';
  const showAll = sp.view === 'all';
  const qs = new URLSearchParams();
  if (!showAll) qs.set('cohort', cohort);
  if (sp.quarter) qs.set('quarter', sp.quarter);
  const data = await api<PilotData>(`/admin/pilot?${qs.toString()}`, '/admin/pilot');
  return (
    <main>
      <h1>Pilot</h1>
      <p className="lede">
        {showAll ? 'All clients' : `Cohort ${cohort}`}, {data.quarter.label} ({day(data.quarter.startsOn)} – {day(data.quarter.endsOn)}).
        Reviewer minutes are estimated from reviewers&apos; recorded actions in the quarter.
      </p>
      <form method="get" className="panel" style={{ display: 'flex', gap: '1rem', alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="field">Cohort<input name="cohort" defaultValue={cohort} pattern="[a-z0-9-]{1,40}" /></label>
        <label className="field">Quarter<input name="quarter" defaultValue={sp.quarter ?? data.quarter.label} pattern="\d{4}-Q[1-4]" /></label>
        <label className="field">Show
          <select name="view" defaultValue={showAll ? 'all' : 'cohort'}><option value="cohort">This cohort</option><option value="all">All clients (to add shops)</option></select>
        </label>
        <button className="btn">Show</button>
      </form>
      {!showAll && <PilotScorecard s={data.scorecard} />}
      <table className="grid" style={{ marginTop: showAll ? '1.5rem' : 0 }}>
        <thead>
          <tr><th>Shop</th><th>Activated</th><th className="num">Reviewer min</th><th>Returns on time</th><th>Status</th><th className="num">Referrals</th><th></th></tr>
        </thead>
        <tbody>
          {data.shops.map((s) => (
            <tr key={s.orgId}>
              <td>{s.orgName}<div className="track-label">signed up {when(s.signedUpAt)}</div></td>
              <td>{s.activation.activated ? 'Yes' : `No: needs ${s.activation.missing.join(', ')}`}</td>
              <td className="num" style={{ color: s.reviewerMinutes >= 20 ? 'var(--red)' : undefined }}>{s.reviewerMinutes}</td>
              <td>{s.filing.due ? `${s.filing.onTime} of ${s.filing.due}` : 'None due yet'}</td>
              <td>{s.churned ? 'Churned' : s.lastOwnerActivity ? `Active ${when(s.lastOwnerActivity)}` : 'No owner activity yet'}</td>
              <td className="num">{s.referrals}</td>
              <td><CohortButton orgId={s.orgId} cohort={cohort} inCohort={s.cohort === cohort} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.shops.length === 0 && <p className="panel">No shops in {cohort} yet. Choose “All clients” to add some.</p>}
    </main>
  );
}
