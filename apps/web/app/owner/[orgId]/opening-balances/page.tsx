import type { FeatureSet } from '@vat-assist/shared';
import { OpeningBalancesForm } from '@/components/owner/OpeningBalancesForm';
import { api } from '@/lib/api';
import { day, rs } from '@/lib/format';

interface Summary {
  recorded: boolean; startDate: string; vatCreditCarriedForwardCents: number;
  accounts: Array<{ tag: string | null; name: string; net_cents: number }>;
  openItems: Array<{ id: string; name: string | null; issue_date: string; gross_cents: number; side: string }>;
}

export default async function OpeningBalancesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const back = `/owner/${orgId}/opening-balances`;
  const [s, f] = await Promise.all([api<Summary>(`/orgs/${orgId}/opening-balances`, back), api<FeatureSet>(`/orgs/${orgId}/features`, back)]);
  return (
    <main className="shell">
      <h1>Opening balances</h1>
      {!f.opening_balances ? (
        <p className="panel">Opening balances are switched off for this business. Ask Nex-Gen.</p>
      ) : s.recorded ? (
        <>
          <p className="lede">Recorded at {day(s.startDate)}. To change them, ask your reviewer: corrections are posted as adjustments so the history stays intact.</p>
          <div className="two">
            <table className="grid">
              <thead><tr><th>Account</th><th className="num">Opening balance</th></tr></thead>
              <tbody>{s.accounts.map((a) => <tr key={a.name}><td>{a.name}</td><td className="num">{rs(Math.abs(a.net_cents))}{a.net_cents < 0 ? ' Cr' : ''}</td></tr>)}</tbody>
            </table>
            <table className="grid">
              <thead><tr><th>Who</th><th>Since</th><th className="num">Amount</th></tr></thead>
              <tbody>{s.openItems.map((i) => <tr key={i.id}><td>{i.name} ({i.side === 'receivable' ? 'owes you' : 'you owe'})</td><td>{day(i.issue_date)}</td><td className="num">{rs(i.gross_cents)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      ) : (
        <OpeningBalancesForm orgId={orgId} startDate={s.startDate} />
      )}
    </main>
  );
}
