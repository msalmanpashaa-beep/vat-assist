import type { VatPot } from '@vat-assist/shared';
import Link from 'next/link';
import { ActionButton } from '@/components/Actions';
import { QueryPanel } from '@/components/QueryPanel';
import { StageTrack } from '@/components/StageTrack';
import { VatPotSlip } from '@/components/VatPotSlip';
import { api } from '@/lib/api';
import { day, flagText, rs } from '@/lib/format';

interface ClientFile {
  org: { legal_name: string; trading_name: string | null; vat_number: string | null; brn: string | null; filing_frequency: string };
  periods: Array<{ id: string; starts_on: string; ends_on: string; status: string; due_on: string; return_id: string | null; version: number | null; return_status: string | null; net_payable_cents: number | null }>;
  vatPot: VatPot;
  documents: Array<{ id: string; status: string; flags: string[]; supplier: string | null; total_cents: number | null; original_filename: string | null }>;
  queries: Parameters<typeof QueryPanel>[0]['queries'];
  ageing: { receivable: { total: number; buckets: Record<string, number> }; payable: { total: number; buckets: Record<string, number> } };
  auditChain: { ok: boolean; checked: number };
  members: Array<{ full_name: string | null; role: string }>;
}

export default async function ClientFilePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const f = await api<ClientFile>(`/reviewer/orgs/${orgId}/file`, `/reviewer/clients/${orgId}`);
  const name = f.org.trading_name ?? f.org.legal_name;
  return (
    <main>
      <h1>{name}</h1>
      <p className="lede">{f.org.legal_name}, VAT {f.org.vat_number ?? 'not registered'}, BRN {f.org.brn ?? '–'}, files {f.org.filing_frequency}. Audit trail {f.auditChain.ok ? `intact (${f.auditChain.checked} events)` : 'BROKEN: escalate now'}.</p>
      <div className="two">
        <VatPotSlip pot={f.vatPot} />
        <div>
          <h2 style={{ marginTop: 0 }}>Money owed</h2>
          <table className="grid">
            <thead><tr><th></th><th className="num">0–30</th><th className="num">31–60</th><th className="num">61–90</th><th className="num">90+</th></tr></thead>
            <tbody>
              {(['receivable', 'payable'] as const).map((side) => (
                <tr key={side}>
                  <td>{side === 'receivable' ? 'Customers owe' : 'Owed to suppliers'}</td>
                  {['0-30', '31-60', '61-90', '90+'].map((b) => <td key={b} className="num">{rs(f.ageing[side].buckets[b] ?? 0)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h2>VAT periods</h2>
      <table className="grid">
        <thead><tr><th>Period</th><th>Stage</th><th>Due</th><th>Return</th><th className="num">Payable</th><th></th></tr></thead>
        <tbody>
          {f.periods.map((p) => (
            <tr key={p.id}>
              <td>{day(p.starts_on)} – {day(p.ends_on)}</td>
              <td><StageTrack status={p.status} /></td>
              <td>{day(p.due_on)}</td>
              <td>{p.return_id ? <Link href={`/reviewer/clients/${orgId}/returns/${p.return_id}`}>Version {p.version}, {p.return_status?.replace('_', ' ')}</Link> : '–'}</td>
              <td className="num">{p.net_payable_cents === null ? '–' : rs(p.net_payable_cents)}</td>
              <td>
                {['open', 'in_review'].includes(p.status) && (
                  <ActionButton path={`/orgs/${orgId}/periods/${p.id}/returns`} label={p.return_id ? 'Prepare new draft' : 'Prepare draft'} then={`/reviewer/clients/${orgId}/returns/:returnId`} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Documents needing attention</h2>
      {f.documents.length === 0 ? <p className="lede">None.</p> : (
        <table className="grid">
          <thead><tr><th>Document</th><th>Status</th><th>Why</th><th className="num">Total</th></tr></thead>
          <tbody>
            {f.documents.map((d) => (
              <tr key={d.id}>
                <td><Link href={`/reviewer/clients/${orgId}/documents/${d.id}`}>{d.supplier ?? d.original_filename ?? 'Document'}</Link></td>
                <td>{d.status.replace(/_/g, ' ')}</td>
                <td>{d.flags[0] ? flagText(d.flags[0]) : '–'}</td>
                <td className="num">{d.total_cents === null ? '–' : rs(d.total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Questions</h2>
      <QueryPanel orgId={orgId} queries={f.queries} canResolve />
    </main>
  );
}
