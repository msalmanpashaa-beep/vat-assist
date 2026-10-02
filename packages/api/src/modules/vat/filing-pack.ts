import PDFDocument from 'pdfkit';
import { formatRs, type GuideStep, type ReturnFigures } from '@vat-assist/shared';
import type { Supporting } from './returns.service';

export interface FilingPackData {
  legalName: string;
  tradingName: string | null;
  vatNumber: string | null;
  brn: string | null;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
  dueStandard: string;
  dueElectronic: string;
  version: number;
  status: string;
  figures: ReturnFigures;
  supporting: Supporting;
  preparedBy: string | null;
  preparedAt: Date;
  signedOffBy: string | null;
  signedOffAt: Date | null;
  fingerprint: string;
  auditHead: { seq: number; hash: string } | null;
  guide: GuideStep[];
}

const INK = '#23408E';
const SLATE = '#1B2430';
const MUTED = '#5B6577';
const RED = '#B42318';
const SLIP = '#F4D35E';

export const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const when = (d: Date | null) => (d ? `${ddmmyyyy(d.toISOString().slice(0, 10))} ${d.toISOString().slice(11, 16)} UTC` : '-');
const rs = (c: number) => formatRs(c, 'en');

/** The pack the owner (or reviewer) files from: figures, sign-off, step-by-step guide, schedules, fingerprint. */
export function renderFilingPack(d: FilingPackData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      bufferPages: true,
      info: { Title: `VAT return ${d.periodLabel} - ${d.legalName}`, Author: 'VAT Assist by Nex-Gen Africa' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const width = doc.page.width - 100;
    const ensure = (space: number) => {
      if (doc.y + space > doc.page.height - 70) doc.addPage();
    };
    const heading = (text: string) => {
      ensure(40);
      doc.moveDown(0.8).fillColor(INK).font('Helvetica-Bold').fontSize(12).text(text, left, doc.y);
      doc.moveDown(0.3);
    };
    const row = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => {
      ensure(18);
      const y = doc.y;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(opts.color ?? SLATE);
      doc.text(label, left, y, { width: width - 200 });
      const after = doc.y;
      doc.text(value, left + width - 190, y, { width: 190, align: 'right' });
      doc.y = Math.max(after, doc.y) + 2;
    };

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(`VAT return filing pack - ${d.periodLabel}`, left, 50);
    doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor(SLATE);
    doc.text(d.tradingName && d.tradingName !== d.legalName ? `${d.legalName} (trading as ${d.tradingName})` : d.legalName);
    doc.text(`VAT number ${d.vatNumber ?? 'not recorded'}    BRN ${d.brn ?? 'not recorded'}`);
    doc.text(`Taxable period ${ddmmyyyy(d.startsOn)} to ${ddmmyyyy(d.endsOn)}    Draft version ${d.version}`);

    const signed = ['signed_off', 'filed', 'paid'].includes(d.status);
    if (!signed) {
      doc.moveDown(0.6);
      const y = doc.y;
      doc.rect(left, y, width, 26).fill('#FDECEA');
      doc.fillColor(RED).font('Helvetica-Bold').fontSize(11).text('DRAFT - not signed off by a Chartered Accountant. Do not file from this copy.', left + 10, y + 8, { width: width - 20 });
      doc.y = y + 34;
    }

    const f = d.figures;
    const payable = f.netPayable > 0;
    doc.moveDown(0.6);
    const boxY = doc.y;
    doc.rect(left, boxY, width, 54).fill(SLIP);
    doc.fillColor(SLATE).font('Helvetica').fontSize(10).text(payable ? 'VAT to pay MRA' : 'Credit carried forward', left + 12, boxY + 9);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(rs(payable ? f.netPayable : f.creditCarriedForward), left + 12, boxY + 23);
    doc.font('Helvetica').fontSize(9).fillColor(SLATE).text(
      `Due ${ddmmyyyy(d.dueStandard)}, or ${ddmmyyyy(d.dueElectronic)} if you file AND pay electronically.`,
      left + 230, boxY + 14, { width: width - 242 },
    );
    doc.y = boxY + 64;

    heading('Return figures');
    row('Standard-rated supplies (excluding VAT)', rs(f.sales.standardRatedNet));
    row('Zero-rated supplies', rs(f.sales.zeroRatedNet));
    row('Exempt supplies', rs(f.sales.exemptNet));
    row('Output tax on sales', rs(f.outputVat.onSales));
    if (f.outputVat.reverseCharge) row('Output tax, reverse charge on imported services (s.14)', rs(f.outputVat.reverseCharge));
    row('Total output tax', rs(f.outputVat.total), { bold: true });
    row('Purchases with VAT claimed (excluding VAT)', rs(f.purchases.standardRatedNet + f.purchases.reverseChargeNet));
    row('Input tax on local purchases', rs(f.inputVat.local));
    if (f.inputVat.lateClaims) row('Input tax claimed late from earlier periods', rs(f.inputVat.lateClaims));
    if (f.inputVat.reverseCharge) row('Input tax, reverse charge', rs(f.inputVat.reverseCharge));
    row('Total input tax', rs(f.inputVat.total), { bold: true });
    if (f.purchases.blockedOrNotClaimableGross) row('Purchases where VAT is blocked or not claimable (gross, for information)', rs(f.purchases.blockedOrNotClaimableGross), { color: MUTED });
    if (f.creditBroughtForward) row('Credit brought forward', rs(f.creditBroughtForward));
    row(payable ? 'VAT payable' : 'Credit carried forward', rs(payable ? f.netPayable : f.creditCarriedForward), { bold: true, color: INK });
    doc.moveDown(0.2).font('Helvetica').fontSize(8).fillColor(MUTED).text(
      'MRA e-filing box numbers are not printed until they have been checked against the live MRA form. Match by description.',
      left, doc.y, { width },
    );

    heading('Review and sign-off');
    row('Prepared by', `${d.preparedBy ?? '-'}, ${when(d.preparedAt)}`);
    row('Signed off by (Chartered Accountant)', signed ? `${d.signedOffBy ?? '-'}, ${when(d.signedOffAt)}` : 'Not signed off');
    row('Documents', `${f.counts.purchaseDocs} purchase, ${f.counts.salesDocs} sales, ${f.counts.lateDocs} late`);
    ensure(30);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Return fingerprint (SHA-256): ${d.fingerprint}`, left, doc.y, { width });
    if (d.auditHead) doc.text(`Audit chain head: event ${d.auditHead.seq}, ${d.auditHead.hash}`, { width });

    heading('How to file');
    d.guide.forEach((s, i) => {
      ensure(30);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(SLATE).text(`${i + 1}. ${s.title}${s.amountCents !== undefined ? `: ${rs(s.amountCents)}` : ''}`, left, doc.y, { width });
      if (s.detail) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(s.detail, { width });
      doc.moveDown(0.25);
    });

    if (d.supporting.inputVatInvoices.length) {
      heading('Schedule A - input tax claimed, by purchase document');
      for (const r of d.supporting.inputVatInvoices) {
        row(`${ddmmyyyy(r.date)}  ${r.supplier ?? '-'}  ${r.reference ?? ''}${r.late ? '  (late)' : ''}`, `${rs(r.netCents)} + ${rs(r.vatCents)}`);
      }
    }
    if (d.supporting.salesInvoices.length) {
      heading('Schedule B - sales invoices');
      for (const r of d.supporting.salesInvoices) {
        row(`${ddmmyyyy(r.date)}  ${r.customer ?? '-'}  ${r.reference ?? ''}${r.late ? '  (late)' : ''}`, `${rs(r.netCents)} + ${rs(r.vatCents)}`);
      }
    }
    if (d.supporting.lateItems.length) {
      heading('Schedule C - documents recorded after their own period closed');
      for (const r of d.supporting.lateItems) row(`${ddmmyyyy(r.date)}  ${r.kind.replace(/_/g, ' ')} ${r.reference ?? ''}: ${r.reason ?? ''}`, '');
    }
    if (d.supporting.reversals.length) {
      heading('Schedule D - reversals in this period');
      for (const r of d.supporting.reversals) row(`Entry ${r.entryNo}: ${r.description} (${r.reason ?? 'no reason'})`, '');
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would make pdfkit start a new page; lift the margin for the footer.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
        `VAT Assist by Nex-Gen Africa   ${d.legalName}   ${d.periodLabel}   page ${i + 1} of ${range.count}`,
        left, doc.page.height - 40, { width, align: 'center', lineBreak: false },
      );
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
