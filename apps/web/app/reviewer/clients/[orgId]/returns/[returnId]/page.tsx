import type { ReturnFigures } from '@vat-assist/shared';
import { ActionButton } from '@/components/Actions';
import { api } from '@/lib/api';
import { day, rs, when } from '@/lib/format';

interface Ret {
  id: string; period_id: string; version: number; status: string; figures: ReturnFigures; fingerprint: string;
  prepared_by_name: string | null; prepared_at: string; signed_off_by_name: string | null; signed_off_at: string | null; mra_reference: string | null;
  supporting: { inputVatInvoices: Array<{ date: string; supplier: string | null; reference: string | null; netCents: number; vatCents: number; late: boolean }> };
}

export default async function ReturnPage({ params }: { params: Promise<{ orgId: string; returnId: string }> }) {
  const { orgId, returnId } = await params;
  const r = await api<Ret>(`/orgs/${orgId}/returns/${returnId}`, `/reviewer/clients/${orgId}/returns/${returnId}`);
  const f = r.figures;
  const line = (label: string, cents: number, strong = false) => (
    <tr><td>{strong ? <strong>{label}</strong> : label}</td><td className="num">{strong ? <strong>{rs(cents)}</strong> : rs(cents)}</td></tr>
  );
  return (
    <main>
      <h1>VAT return {day(f.periodStart)} – {day(f.periodEnd)}</h1>
      <p className="lede">
        Version {r.version}, {r.status.replace('_', ' ')}. Prepared by {r.prepared_by_name ?? '–'} on {when(r.prepared_at)}.
        {r.signed_off_at ? ` Signed off by ${r.signed_off_by_name} on ${when(r.signed_off_at)}.` : ''}
        {r.mra_reference ? ` MRA acknowledgement ${r.mra_reference}.` : ''}
      </p>
      <div className="two">
        <table className="grid">
          <tbody>
            {line('Standard-rated sales, before VAT', f.sales.standardRatedNet)}
            {line('Zero-rated sales', f.sales.zeroRatedNet)}
            {line('Exempt sales', f.sales.exemptNet)}
            {line('Output VAT', f.outputVat.total, true)}
            {line('Purchases with VAT claimed, before VAT', f.purchases.standardRatedNet + f.purchases.reverseChargeNet)}
            {line('Input VAT', f.inputVat.total, true)}
            {f.inputVat.lateClaims > 0 && line('of which claimed late', f.inputVat.lateClaims)}
            {f.creditBroughtForward > 0 && line('Credit brought forward', f.creditBroughtForward)}
            {f.netPayable > 0 ? line('VAT payable', f.netPayable, true) : line('Credit carried forward', f.creditCarriedForward, true)}
          </tbody>
        </table>
        <div className="panel">
          <p>{f.counts.purchaseDocs} purchase and {f.counts.salesDocs} sales documents, {f.counts.lateDocs} late.</p>
          {f.counts.openBlockingQueries > 0 && <p className="msg err">{f.counts.openBlockingQueries} blocking question(s) open when this draft was made.</p>}
          <p style={{ wordBreak: 'break-all', fontSize: '0.85rem' }} className="track-label">Fingerprint {r.fingerprint}</p>
          <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a className="btn quiet" href={`/api/proxy/orgs/${orgId}/returns/${returnId}/filing-pack.pdf`}>Download filing pack</a>
            {r.status === 'draft' && (
              <ActionButton path={`/orgs/${orgId}/returns/${returnId}/sign-off`} label="Sign off and lock" confirm="Sign off as the Chartered Accountant responsible? The period locks and later documents go to the next period." />
            )}
            {r.status === 'paid' && <ActionButton path={`/orgs/${orgId}/periods/${r.period_id}/close`} label="Close the period" />}
          </p>
        </div>
      </div>
      <h2>Input VAT claimed</h2>
      <table className="grid">
        <thead><tr><th>Date</th><th>Supplier</th><th>Reference</th><th className="num">Before VAT</th><th className="num">VAT</th></tr></thead>
        <tbody>
          {r.supporting.inputVatInvoices.map((i, k) => (
            <tr key={k}><td>{day(i.date)}</td><td>{i.supplier}{i.late ? ' (late)' : ''}</td><td>{i.reference}</td><td className="num">{rs(i.netCents)}</td><td className="num">{rs(i.vatCents)}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
