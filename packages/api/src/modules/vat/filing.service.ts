import { Injectable } from '@nestjs/common';
import { addDays, formatRs, type GuideStep, type IsoDate } from '@vat-assist/shared';
import type { OrgScope } from '../../common/auth-context';
import { DomainError, conflict, notFound } from '../../common/errors';
import type { Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { type PeriodRow, PeriodsService, periodLabel } from '../core/periods.service';
import { LedgerService } from '../ledger/ledger.service';
import type { DraftLine } from '../ledger/posting-rules';
import { ddmmyyyy, renderFilingPack } from './filing-pack';
import { type ReturnRow, ReturnsService } from './returns.service';

/** Guided filing, the filing-pack PDF, the MRA acknowledgement, payment, and closing the period. */
@Injectable()
export class FilingService {
  constructor(
    private readonly returns: ReturnsService,
    private readonly periods: PeriodsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  guide(r: Pick<ReturnRow, 'figures'>, p: PeriodRow): GuideStep[] {
    const f = r.figures;
    const payable = f.netPayable > 0;
    const steps: GuideStep[] = [
      { key: 'sign_in', title: 'Sign in to MRA e-Services', detail: 'Use your own MRA login on mra.mu (e-Services, VAT). Nex-Gen never asks for your MRA password.' },
      { key: 'period', title: `Open the VAT return for ${periodLabel(p)}`, detail: `Taxable period ${ddmmyyyy(p.starts_on)} to ${ddmmyyyy(p.ends_on)}.` },
      { key: 'sales_standard', title: 'Standard-rated supplies, excluding VAT', amountCents: f.sales.standardRatedNet, mraField: null, detail: 'Sales charged at 15%.' },
      { key: 'sales_zero', title: 'Zero-rated supplies', amountCents: f.sales.zeroRatedNet, mraField: null, detail: '' },
      { key: 'sales_exempt', title: 'Exempt supplies', amountCents: f.sales.exemptNet, mraField: null, detail: '' },
      {
        key: 'output_vat', title: 'Output tax', amountCents: f.outputVat.total, mraField: null,
        detail: f.outputVat.reverseCharge ? `Includes ${formatRs(f.outputVat.reverseCharge)} reverse charge on imported services.` : 'VAT on your sales.',
      },
      { key: 'purchases', title: 'Purchases on which you claim VAT, excluding VAT', amountCents: f.purchases.standardRatedNet + f.purchases.reverseChargeNet, mraField: null, detail: '' },
      {
        key: 'input_vat', title: 'Input tax claimed', amountCents: f.inputVat.total, mraField: null,
        detail: f.inputVat.lateClaims ? `Includes ${formatRs(f.inputVat.lateClaims)} claimed late from earlier periods.` : '',
      },
    ];
    if (f.creditBroughtForward) steps.push({ key: 'credit_bf', title: 'Credit brought forward from your last return', amountCents: f.creditBroughtForward, mraField: null, detail: '' });
    steps.push(
      { key: 'result', title: payable ? 'VAT payable' : 'Credit carried forward', amountCents: payable ? f.netPayable : f.creditCarriedForward, mraField: null, detail: 'Check that MRA shows the same amount before you submit.' },
      { key: 'submit', title: 'Submit, then save the acknowledgement', detail: 'Download or screenshot the page that shows the MRA acknowledgement number.' },
      {
        key: 'pay', title: payable ? 'Pay the VAT electronically' : 'Nothing to pay this time',
        detail: payable
          ? `Filing and paying electronically gives you until ${ddmmyyyy(p.extended_due_on)}. Otherwise pay by ${ddmmyyyy(p.due_on)}.`
          : 'The credit carries forward to your next return.',
      },
      { key: 'attach', title: 'Add the acknowledgement in VAT Assist', detail: 'Photograph or upload it and type the reference number. Your reviewer then closes the period.' },
    );
    return steps;
  }

  private async loadReturn(tx: Tx, orgId: string, returnId: string, forUpdate = false): Promise<ReturnRow> {
    const r = await tx.maybe<ReturnRow>(`select * from vat_returns where id = $1 and org_id = $2${forUpdate ? ' for update' : ''}`, [returnId, orgId]);
    if (!r) throw notFound('VAT return');
    return r;
  }

  async guideFor(tx: Tx, orgId: string, returnId: string) {
    const r = await this.loadReturn(tx, orgId, returnId);
    const p = await this.periods.byId(tx, r.period_id);
    return { returnId: r.id, status: r.status, periodLabel: periodLabel(p), steps: this.guide(r, p) };
  }

  async filingPack(tx: Tx, orgId: string, returnId: string): Promise<{ filename: string; pdf: Buffer }> {
    const r = await this.returns.get(tx, orgId, returnId);
    const p = await this.periods.byId(tx, r.period_id);
    const org = await tx.one<{ legal_name: string; trading_name: string | null; vat_number: string | null; brn: string | null }>(
      `select legal_name, trading_name, vat_number, brn from organisations where id = $1`,
      [orgId],
    );
    const head = await this.audit.head(tx, orgId);
    const pdf = await renderFilingPack({
      legalName: org.legal_name,
      tradingName: org.trading_name,
      vatNumber: org.vat_number,
      brn: org.brn,
      periodLabel: periodLabel(p),
      startsOn: p.starts_on,
      endsOn: p.ends_on,
      dueStandard: p.due_on,
      dueElectronic: p.extended_due_on,
      version: r.version,
      status: r.status,
      figures: r.figures,
      supporting: r.supporting,
      preparedBy: r.prepared_by_name,
      preparedAt: r.prepared_at,
      signedOffBy: r.signed_off_by_name,
      signedOffAt: r.signed_off_at,
      fingerprint: r.fingerprint,
      auditHead: head,
      guide: this.guide(r, p),
    });
    const safe = org.legal_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { filename: `VAT-return-${safe}-${periodLabel(p).replace(/\s+/g, '-')}-v${r.version}.pdf`, pdf };
  }

  /** Filed: keep the acknowledgement, then move the period's VAT into "VAT payable to MRA" in the next period. */
  async attachAcknowledgement(tx: Tx, s: OrgScope, returnId: string, body: { mraReference: string; documentId: string }) {
    const r = await this.loadReturn(tx, s.orgId, returnId, true);
    if (r.status !== 'signed_off') throw conflict('not_signed_off', 'Only a signed-off return can be marked as filed.');
    const doc = await tx.maybe<{ kind: string }>(`select kind from documents where id = $1 and org_id = $2`, [body.documentId, s.orgId]);
    if (!doc) throw notFound('Acknowledgement document');
    if (doc.kind !== 'mra_acknowledgement') throw new DomainError('wrong_document', 'Upload the MRA acknowledgement as an "MRA acknowledgement" document.', 400);
    const period = await tx.one<PeriodRow>(`select * from vat_periods where id = $1 for update`, [r.period_id]);
    await tx.exec(
      `update vat_returns set status = 'filed', mra_reference = $2, acknowledgement_document_id = $3, filed_at = now() where id = $1`,
      [r.id, body.mraReference, body.documentId],
    );
    await tx.exec(`update vat_periods set status = 'filed' where id = $1`, [period.id]);

    const f = r.figures;
    const lines: DraftLine[] = [];
    if (f.outputVat.total) lines.push({ account: { tag: 'output_vat' }, debit: Math.max(f.outputVat.total, 0), credit: Math.max(-f.outputVat.total, 0) });
    if (f.inputVat.total) lines.push({ account: { tag: 'input_vat' }, debit: Math.max(-f.inputVat.total, 0), credit: Math.max(f.inputVat.total, 0) });
    const net = f.outputVat.total - f.inputVat.total;
    if (net) lines.push({ account: { tag: 'vat_payable' }, debit: Math.max(-net, 0), credit: Math.max(net, 0) });
    let settlementEntryNo: number | null = null;
    if (lines.length >= 2) {
      const next = await this.periods.firstOpenFrom(tx, s.orgId, addDays(period.ends_on, 1));
      const e = await this.ledger.writeEntry(tx, {
        orgId: s.orgId,
        period: next,
        entryDate: next.starts_on,
        sourceType: 'vat_settlement',
        description: `VAT return ${periodLabel(period)} filed (MRA ref ${body.mraReference})`,
        postedBy: s.userId,
        lines,
      });
      settlementEntryNo = e.entryNo;
    }
    await this.audit.log(tx, 'return.filed', 'vat_return', r.id, { mraReference: body.mraReference, settlementEntryNo });
    return { returnId: r.id, status: 'filed' as const, settlementEntryNo };
  }

  async confirmPayment(tx: Tx, s: OrgScope, returnId: string, body: { paymentReference: string; paidOn: IsoDate; documentId?: string }) {
    const r = await this.loadReturn(tx, s.orgId, returnId, true);
    if (r.status !== 'filed') throw conflict('not_filed', 'Record the MRA acknowledgement before the payment.');
    const period = await tx.one<PeriodRow>(`select * from vat_periods where id = $1 for update`, [r.period_id]);
    let paymentEntryNo: number | null = null;
    if (r.figures.netPayable > 0) {
      const target = await this.periods.firstOpenFrom(tx, s.orgId, body.paidOn);
      const entryDate = body.paidOn < target.starts_on ? target.starts_on : body.paidOn > target.ends_on ? target.ends_on : body.paidOn;
      const e = await this.ledger.writeEntry(tx, {
        orgId: s.orgId,
        period: target,
        entryDate,
        sourceType: 'adjustment',
        description: `VAT paid to MRA for ${periodLabel(period)} (${body.paymentReference})`,
        postedBy: s.userId,
        lines: [
          { account: { tag: 'vat_payable' }, debit: r.figures.netPayable, credit: 0 },
          { account: { tag: 'bank' }, debit: 0, credit: r.figures.netPayable },
        ],
      });
      paymentEntryNo = e.entryNo;
    }
    await tx.exec(
      `update vat_returns set status = 'paid', payment_reference = $2, paid_on = $3, payment_document_id = $4 where id = $1`,
      [r.id, body.paymentReference, body.paidOn, body.documentId ?? null],
    );
    await tx.exec(`update vat_periods set status = 'paid' where id = $1`, [period.id]);
    await this.audit.log(tx, 'return.paid', 'vat_return', r.id, { paymentReference: body.paymentReference, amountCents: r.figures.netPayable, paymentEntryNo });
    return { returnId: r.id, status: 'paid' as const, paymentEntryNo };
  }

  async ready(tx: Tx, s: OrgScope, periodId: string) {
    const p = await tx.maybe<PeriodRow>(`select * from vat_periods where id = $1 and org_id = $2 for update`, [periodId, s.orgId]);
    if (!p) throw notFound('VAT period');
    if (p.status !== 'open') throw conflict('not_open', `${periodLabel(p)} is already ${p.status.replace('_', ' ')}.`);
    await tx.exec(`update vat_periods set status = 'in_review' where id = $1`, [p.id]);
    await this.audit.log(tx, 'period.ready_for_review', 'vat_period', p.id, { period: periodLabel(p) });
    return { periodId: p.id, status: 'in_review' as const };
  }

  async close(tx: Tx, s: OrgScope, periodId: string) {
    const p = await tx.maybe<PeriodRow>(`select * from vat_periods where id = $1 and org_id = $2 for update`, [periodId, s.orgId]);
    if (!p) throw notFound('VAT period');
    const r = await tx.maybe<ReturnRow>(`select * from vat_returns where period_id = $1 and status in ('filed', 'paid') order by version desc limit 1`, [p.id]);
    if (p.status === 'filed' && r && r.figures.netPayable === 0) {
      await tx.exec(`update vat_periods set status = 'paid' where id = $1`, [p.id]);
    } else if (p.status !== 'paid') {
      throw conflict('not_ready_to_close', 'A period closes once its return is filed and any VAT due is paid.');
    }
    await tx.exec(`update vat_periods set status = 'closed' where id = $1`, [p.id]);
    await this.audit.log(tx, 'period.closed', 'vat_period', p.id, { period: periodLabel(p) });
    return { periodId: p.id, status: 'closed' as const };
  }
}
