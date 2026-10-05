/** Pilot scorecard tiles: each metric against its target, marked on track or behind. */
export interface PilotScore {
  shops: { value: number; target: number; pass: boolean };
  activationRate: { value: number | null; activated: number; target: number; pass: boolean };
  reviewerMinutes: { averagePerShop: number; maxPerShop: number; shopsAtOrOverTarget: number; target: number; pass: boolean };
  onTimeFilingRate: { value: number | null; onTime: number; due: number; target: number; pass: boolean };
  churnRate: { value: number | null; churned: number; target: number; pass: boolean };
  referrals: { value: number; target: number; pass: boolean };
}

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

function Tile({ label, value, detail, target, pass }: { label: string; value: string; detail: string; target: string; pass: boolean }) {
  return (
    <div className="panel" role="group" aria-label={label} style={{ borderLeft: `6px solid ${pass ? 'var(--green)' : 'var(--amber)'}` }}>
      <div className="track-label">{label}</div>
      <div style={{ fontSize: '1.8rem', fontWeight: 800 }}>{value}</div>
      <div className="track-label">{detail}</div>
      <div style={{ marginTop: 6, fontWeight: 700, color: pass ? 'var(--green)' : 'var(--amber)' }}>{pass ? 'On track' : 'Behind'} · target {target}</div>
    </div>
  );
}

export function PilotScorecard({ s }: { s: PilotScore }) {
  return (
    <section aria-label="Pilot scorecard" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', margin: '1rem 0 2rem' }}>
      <Tile label="Shops in the pilot" value={String(s.shops.value)} detail="businesses in this cohort" target={`${s.shops.target}`} pass={s.shops.pass} />
      <Tile label="Activation" value={pct(s.activationRate.value)} detail={`${s.activationRate.activated} activated within 14 days`} target={`≥ ${pct(s.activationRate.target)}`} pass={s.activationRate.pass} />
      <Tile label="Reviewer minutes per shop" value={`${s.reviewerMinutes.averagePerShop}`} detail={`highest ${s.reviewerMinutes.maxPerShop}; ${s.reviewerMinutes.shopsAtOrOverTarget} shop(s) at or over`} target={`< ${s.reviewerMinutes.target} per quarter`} pass={s.reviewerMinutes.pass} />
      <Tile label="On-time filing" value={pct(s.onTimeFilingRate.value)} detail={`${s.onTimeFilingRate.onTime} of ${s.onTimeFilingRate.due} returns due`} target={`≥ ${pct(s.onTimeFilingRate.target)}`} pass={s.onTimeFilingRate.pass} />
      <Tile label="Churn" value={pct(s.churnRate.value)} detail={`${s.churnRate.churned} shop(s) cancelled or inactive 45 days`} target={`≤ ${pct(s.churnRate.target)}`} pass={s.churnRate.pass} />
      <Tile label="Referrals" value={String(s.referrals.value)} detail="new shops signed up with a pilot shop's code" target={`≥ ${s.referrals.target}`} pass={s.referrals.pass} />
    </section>
  );
}
