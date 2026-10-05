import type { VatPot } from '@vat-assist/shared';
import { ActionButton } from '@/components/Actions';
import { StageTrack } from '@/components/StageTrack';
import { VatPotSlip } from '@/components/VatPotSlip';
import { api } from '@/lib/api';
import { day, rs } from '@/lib/format';

interface Period { id: string; starts_on: string; ends_on: string; status: string; due_on: string; extended_due_on: string; return_id: string | null; return_status: string | null; net_payable_cents: number | null }

interface Incoming { id: string; provider: string; amount_cents: number; payer_name: string | null; payer_reference: string | null; received_on: string | null; reference: string | null; proofUrl: string | null }

export default async function OwnerShop({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [pot, periods, incoming, org] = await Promise.all([
    api<VatPot>(`/orgs/${orgId}/vat-pot`, `/owner/${orgId}`),
    api<Period[]>(`/orgs/${orgId}/periods`, `/owner/${orgId}`),
    api<Incoming[]>(`/orgs/${orgId}/incoming-payments?status=awaiting_confirmation`, `/owner/${orgId}`),
    api<{ referral_code: string | null }>(`/orgs/${orgId}`, `/owner/${orgId}`),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <main className="shell">
      <h1>Your VAT</h1>
      <p className="lede">Take photos of bills and record sales in the app. This page shows where each return stands.</p>
      <VatPotSlip pot={pot} />
      {org.referral_code && (
        <p className="lede" style={{ marginTop: '1rem' }}>Your referral code: <strong>{org.referral_code}</strong>. Give it to other shop owners when they sign up.</p>
      )}
      {incoming.length > 0 && (
        <>
          <h2>Payments to confirm</h2>
          <p className="lede">Customers say they sent these. Check your Juice or bank account first.</p>
          <table className="grid">
            <thead><tr><th>From</th><th>How</th><th>Sent</th><th className="num">Amount</th><th></th></tr></thead>
            <tbody>
              {incoming.map((p) => (
                <tr key={p.id}>
                  <td>{p.payer_name ?? 'Customer'}{p.payer_reference ? `, ${p.payer_reference}` : ''} (ref {p.reference}){p.proofUrl && <> <a href={p.proofUrl}>screenshot</a></>}</td>
                  <td>{p.provider === 'juice' ? 'Juice' : 'Bank transfer'}</td>
                  <td>{day(p.received_on)}</td>
                  <td className="num">{rs(p.amount_cents)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <ActionButton path={`/orgs/${orgId}/incoming-payments/${p.id}/confirm`} body={{ receivedOn: p.received_on ?? today }} label="Money received" />{' '}
                    <ActionButton path={`/orgs/${orgId}/incoming-payments/${p.id}/reject`} body={{ reason: 'The money did not arrive' }} label="Not received" variant="quiet" confirm="Mark this as not received? The customer's link stays open." />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2>Returns</h2>
      <table className="grid">
        <thead><tr><th>Period</th><th>Stage</th><th>Due</th><th className="num">To pay</th><th></th></tr></thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id}>
              <td>{day(p.starts_on)} – {day(p.ends_on)}</td>
              <td><StageTrack status={p.status} /></td>
              <td>{day(p.due_on)}, online {day(p.extended_due_on)}</td>
              <td className="num">{p.net_payable_cents === null ? '–' : rs(p.net_payable_cents)}</td>
              <td>{p.return_id && ['signed_off', 'filed', 'paid'].includes(p.return_status ?? '') && <a href={`/api/proxy/orgs/${orgId}/returns/${p.return_id}/filing-pack.pdf`}>Filing pack</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
