import type { ExtractedInvoice } from '@vat-assist/shared';
import { ActionButton } from '@/components/Actions';
import { ApproveForm } from '@/components/ApproveForm';
import { api } from '@/lib/api';
import { flagText, rs } from '@/lib/format';

interface Doc {
  id: string; kind: string; status: string; mime_type: string; original_filename: string | null; confidence: number | null; flags: string[];
  extraction: ExtractedInvoice | null; downloadUrl: string;
  transaction: { id: string; status: string; settlement: string | null; is_late: boolean } | null;
}
const BLOCKING = new Set(['missing_supplier_vat_number', 'duplicate_invoice', 'claim_window_expired', 'extraction_failed']);

export default async function DocumentReview({ params }: { params: Promise<{ orgId: string; docId: string }> }) {
  const { orgId, docId } = await params;
  const d = await api<Doc>(`/orgs/${orgId}/documents/${docId}`, `/reviewer/clients/${orgId}/documents/${docId}`);
  const x = d.extraction;
  const row = (label: string, v: { value: unknown; confidence: number } | undefined, money = false) => (
    <tr>
      <td>{label}</td>
      <td>{v?.value == null ? '–' : money ? rs(Number(v.value)) : String(v.value)}</td>
      <td className={`num conf ${v && v.confidence < 0.8 ? 'low' : ''}`}>{v ? Math.round(v.confidence * 100) : 0}%</td>
    </tr>
  );
  return (
    <main>
      <h1>{x?.supplierName.value ?? 'Document'} {x?.invoiceNumber.value ?? ''}</h1>
      <p className="lede">Status {d.status.replace(/_/g, ' ')}. {d.transaction ? `The owner said it was ${d.transaction.settlement === 'credit' ? 'bought on credit' : 'paid'}.` : 'The owner has not answered yet.'}</p>
      {d.flags.map((f) => <div key={f} className={`flag ${BLOCKING.has(f) ? 'blocking' : ''}`}>{flagText(f)}</div>)}
      <div className="two" style={{ marginTop: '1rem' }}>
        <div>
          {d.mime_type.startsWith('image/') ? <img className="doc-img" src={d.downloadUrl} alt="Uploaded document" /> : <a href={d.downloadUrl}>Open the PDF</a>}
          {x && (
            <table className="grid" style={{ marginTop: '1rem' }}>
              <thead><tr><th>Read by the system</th><th></th><th className="num">Sure</th></tr></thead>
              <tbody>
                {row('Supplier', x.supplierName)}{row('Supplier VAT number', x.supplierVatNumber)}{row('Invoice number', x.invoiceNumber)}
                {row('Date', x.invoiceDate)}{row('Before VAT', x.netCents, true)}{row('VAT', x.vatCents, true)}{row('Total', x.totalCents, true)}{row('Addressed to', x.buyerName)}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {d.transaction && ['needs_review', 'draft'].includes(d.transaction.status) && x ? (
            <ApproveForm orgId={orgId} docId={docId} initial={{
              supplierName: x.supplierName.value, supplierVatNumber: x.supplierVatNumber.value, invoiceNumber: x.invoiceNumber.value,
              invoiceDate: x.invoiceDate.value, netCents: x.netCents.value, vatCents: x.vatCents.value, category: null,
            }} />
          ) : (
            <p className="panel">{d.status === 'posted' ? 'Already posted to the books.' : 'Waiting for the owner to answer the two questions in the app.'}</p>
          )}
          {d.status !== 'posted' && (
            <p style={{ marginTop: '1rem' }}>
              <ActionButton path={`/orgs/${orgId}/documents/${docId}/archive`} body={{ reason: 'Not a business document for this shop' }} label="Not a business document" variant="quiet" confirm="Keep it on file but leave it out of the books?" />
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
