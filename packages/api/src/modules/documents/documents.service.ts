import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  addDays, DocumentAnswersBody, type ExtractedInvoice, normaliseVatNumber, PURCHASE_CATEGORIES, type PurchaseCategoryKey,
  ReviewerApproveBody, todayIn, UploadUrlBody, type VatCode,
} from '@vat-assist/shared';
import type { z } from 'zod';
import { AppConfig } from '../../config';
import type { OrgScope } from '../../common/auth-context';
import { DomainError, conflict, notFound } from '../../common/errors';
import { Db, type Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { JobsService } from '../core/jobs.service';
import { StorageService } from '../core/storage.service';
import { findOrCreateContact } from '../ledger/contacts';
import { LedgerService } from '../ledger/ledger.service';
import { canAutoPost } from './scoring';

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

interface DocForAnswer {
  id: string;
  status: string;
  extraction: (ExtractedInvoice & { checks?: Array<{ code: string; severity: string; message: string }> }) | null;
  flags: string[];
  confidence: string | null;
}

type Settlement = z.output<typeof DocumentAnswersBody>['settlement'];

/** VAT code for a purchase line from what the owner said it was for, and what the invoice shows. */
export function purchaseVatCode(category: PurchaseCategoryKey, vatCents: number, supplierHasVatNumber: boolean, flags: string[]): VatCode {
  const t = PURCHASE_CATEGORIES[category].vat;
  if (t === 'reverse_charge' || t === 'reverse_charge_blocked') return vatCents > 0 ? 'NC' : 'RC';
  if (vatCents === 0) return supplierHasVatNumber ? 'ZR' : 'OS';
  if (t === 'blocked') return 'BL';
  if (t === 'none') return 'NC';
  if (flags.includes('missing_supplier_vat_number')) return 'NC';
  return 'SR';
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  private today() {
    return todayIn(this.cfg.env.TZ_BUSINESS);
  }

  /** Step 1: reserve a document and hand the phone a short-lived upload link straight to storage. */
  async createUpload(s: OrgScope, body: z.output<typeof UploadUrlBody>) {
    if (body.byteSize > this.cfg.env.MAX_UPLOAD_BYTES) throw new DomainError('too_large', 'That file is too large.', 413);
    const id = randomUUID();
    const [y, m] = this.today().split('-');
    const key = `${s.orgId}/${y}/${m}/${id}${EXT[body.mimeType]}`;
    await this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      await tx.exec(
        `insert into documents (id, org_id, kind, source, storage_key, mime_type, byte_size, original_filename, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, s.orgId, body.kind, body.source, key, body.mimeType, body.byteSize, body.originalFilename ?? null, s.userId],
      );
      await this.audit.log(tx, 'document.upload_started', 'document', id, { kind: body.kind, source: body.source });
    });
    return { documentId: id, upload: await this.storage.presignUpload(key, body.mimeType, Math.min(body.byteSize + 1024, this.cfg.env.MAX_UPLOAD_BYTES)) };
  }

  /** Step 2: the phone says the upload finished; processing starts (inline in dev, queued in production). */
  async complete(s: OrgScope, id: string) {
    const doc = await this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      const d = await tx.maybe<{ id: string; status: string; storage_key: string }>(`select id, status, storage_key from documents where id = $1 for update`, [id]);
      if (!d) throw notFound('Document');
      if (d.status !== 'uploading') return d;
      if (!(await this.storage.exists(d.storage_key))) throw conflict('upload_missing', 'The file has not arrived yet. Try the upload again.');
      await tx.exec(`update documents set status = 'processing' where id = $1`, [id]);
      await this.audit.log(tx, 'document.uploaded', 'document', id);
      return { ...d, status: 'processing' };
    });
    if (doc.status === 'processing') await this.jobs.enqueue('document.process', { orgId: s.orgId, documentId: id });
    return this.get(s, id);
  }

  async get(s: OrgScope, id: string) {
    return this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      const d = await tx.maybe<Record<string, unknown> & { storage_key: string }>(
        `select id, kind, source, status, mime_type, original_filename, confidence, flags, quality, extraction, extraction_provider,
                duplicate_of, created_at, processed_at, storage_key from documents where id = $1`,
        [id],
      );
      if (!d) throw notFound('Document');
      const transaction = await tx.maybe(
        `select id, kind, status, reference, issue_date, settlement, net_cents, vat_cents, gross_cents, is_late, late_reason
         from transactions where document_id = $1 and status <> 'void' order by created_at desc limit 1`,
        [id],
      );
      const { storage_key, ...rest } = d;
      return { ...rest, downloadUrl: await this.storage.downloadUrl(storage_key), transaction };
    });
  }

  async list(s: OrgScope, status?: string) {
    return this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, (tx) =>
      tx.many(
        `select id, kind, status, original_filename, confidence, flags, created_at,
                extraction->'supplierName'->>'value' as supplier, extraction->'totalCents'->>'value' as total_cents
         from documents where org_id = $1 and ($2::text is null or status = $2) order by created_at desc limit 200`,
        [s.orgId, status ?? null],
      ),
    );
  }

  /** Step 3: the owner answers "paid now or later?" and "what is it for?". Clean items post; the rest go to review. */
  async answer(s: OrgScope, id: string, body: z.output<typeof DocumentAnswersBody>) {
    return this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      const doc = await this.lockDoc(tx, id, ['awaiting_owner']);
      const x = doc.extraction as ExtractedInvoice;
      const supplierVat = normaliseVatNumber(x.supplierVatNumber.value);
      const contact = await findOrCreateContact(tx, s.orgId, { name: x.supplierName.value ?? 'Unknown supplier', kind: 'supplier', vatNumber: supplierVat });
      const category = (body.category ?? contact.default_category) as PurchaseCategoryKey | null;
      if (!category || !(category in PURCHASE_CATEGORIES)) throw new DomainError('category_required', 'What is it for? Choose a category.', 400);
      if (!contact.default_category) await tx.exec(`update contacts set default_category = $2 where id = $1`, [contact.id, category]);
      const transactionId = await this.createPurchase(tx, s.orgId, s.userId, doc, contact.id, contact.payment_terms_days, category, body.settlement);
      const confidence = Number(doc.confidence ?? 0);
      const auto = canAutoPost(confidence, doc.flags, this.cfg.env.AUTO_POST_THRESHOLD, PURCHASE_CATEGORIES[category].alwaysReview);
      const outcome = auto ? await this.tryPost(tx, s.userId, doc.id, transactionId, category) : null;
      if (!outcome?.posted) {
        await tx.exec(`update transactions set status = 'needs_review' where id = $1`, [transactionId]);
        await tx.exec(`update documents set status = 'needs_review' where id = $1`, [doc.id]);
      }
      const reasons = outcome?.error ? [outcome.error] : auto ? [] : doc.flags.length ? doc.flags : ['low_confidence_or_category'];
      await this.audit.log(tx, 'document.answered', 'document', doc.id, { settlement: body.settlement.mode, category, posted: !!outcome?.posted, reasons });
      return { outcome: outcome?.posted ? 'posted' : 'needs_review', transactionId, reasons };
    });
  }

  /** Reviewer: correct what the AI misread, then post. Corrections are kept in the extraction and audit trail. */
  async approve(s: OrgScope, id: string, body: z.output<typeof ReviewerApproveBody>) {
    return this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      const doc = await this.lockDoc(tx, id, ['needs_review']);
      const t = await tx.maybe<{ id: string; status: string; category: string | null; contact_id: string }>(
        `select id, status, category, contact_id from transactions where document_id = $1 and status = 'needs_review' for update`,
        [doc.id],
      );
      if (!t) throw conflict('owner_answer_missing', 'The owner has not said yet whether this was paid now or later.');
      const c = body.corrections;
      const category = (c.category ?? t.category) as PurchaseCategoryKey;
      if (Object.keys(c).length) {
        const x = doc.extraction as ExtractedInvoice;
        const set = <T>(f: { value: T | null; confidence: number }, v: T | undefined) => (v === undefined ? f : { value: v, confidence: 1 });
        const fixed: ExtractedInvoice = {
          ...x,
          supplierName: set(x.supplierName, c.supplierName),
          supplierVatNumber: set(x.supplierVatNumber, c.supplierVatNumber),
          invoiceNumber: set(x.invoiceNumber, c.invoiceNumber),
          invoiceDate: set(x.invoiceDate, c.invoiceDate),
          netCents: set(x.netCents, c.netCents),
          vatCents: set(x.vatCents, c.vatCents),
          totalCents: c.netCents !== undefined || c.vatCents !== undefined
            ? { value: (c.netCents ?? x.netCents.value ?? 0) + (c.vatCents ?? x.vatCents.value ?? 0), confidence: 1 }
            : x.totalCents,
        };
        const supplierVat = normaliseVatNumber(fixed.supplierVatNumber.value);
        if (c.supplierVatNumber) await tx.exec(`update contacts set vat_number = $2 where id = $1 and vat_number is null`, [t.contact_id, supplierVat]);
        const flags = doc.flags.filter((f) => !(f === 'missing_supplier_vat_number' && supplierVat));
        const net = fixed.netCents.value ?? 0;
        const vat = fixed.vatCents.value ?? 0;
        await tx.exec(`delete from lines where transaction_id = $1`, [t.id]);
        await tx.exec(
          `update transactions set reference = $2, issue_date = $3, net_cents = $4, vat_cents = $5, gross_cents = $6, category = $7 where id = $1`,
          [t.id, fixed.invoiceNumber.value, fixed.invoiceDate.value ?? this.today(), net, vat, net + vat, category],
        );
        await this.insertLine(tx, s.orgId, t.id, category, net, vat, !!supplierVat, flags, fixed.supplierName.value);
        await tx.exec(`update documents set extraction = extraction || $2::jsonb, flags = $3 where id = $1`, [doc.id, JSON.stringify(fixed), flags]);
      }
      const posting = await this.ledger.postTransaction(tx, s.userId, t.id, {
        today: this.today(),
        lateReason: body.lateReason,
        treatExpiredClaimAsCost: body.treatExpiredClaimAsCost,
        reverseChargeInputBlocked: PURCHASE_CATEGORIES[category]?.vat === 'reverse_charge_blocked',
      });
      await tx.exec(`update documents set status = 'posted' where id = $1`, [doc.id]);
      await this.audit.log(tx, 'document.approved', 'document', doc.id, { corrections: Object.keys(c), entryNo: posting.entryNo, late: posting.late });
      return { outcome: 'posted', transactionId: t.id, posting };
    });
  }

  async archive(s: OrgScope, id: string, reason: string) {
    return this.db.run({ kind: 'user', userId: s.userId, orgId: s.orgId }, async (tx) => {
      const doc = await this.lockDoc(tx, id, ['awaiting_owner', 'needs_review', 'failed', 'rejected_quality']);
      await tx.exec(`delete from transactions where document_id = $1 and status in ('draft', 'awaiting_owner', 'needs_review')`, [doc.id]);
      await tx.exec(`update documents set status = 'archived' where id = $1`, [doc.id]);
      await this.audit.log(tx, 'document.archived', 'document', doc.id, { reason });
      return { archived: true };
    });
  }

  private async lockDoc(tx: Tx, id: string, allowed: string[]): Promise<DocForAnswer> {
    const doc = await tx.maybe<DocForAnswer>(`select id, status, extraction, flags, confidence from documents where id = $1 for update`, [id]);
    if (!doc) throw notFound('Document');
    if (!allowed.includes(doc.status)) throw conflict('wrong_status', `This document is ${doc.status.replace('_', ' ')}.`);
    return doc;
  }

  private async createPurchase(
    tx: Tx, orgId: string, userId: string, doc: DocForAnswer, contactId: string, terms: number | null,
    category: PurchaseCategoryKey, settlement: Settlement,
  ): Promise<string> {
    const x = doc.extraction as ExtractedInvoice;
    const net = x.netCents.value ?? (x.totalCents.value ?? 0) - (x.vatCents.value ?? 0);
    const vat = x.vatCents.value ?? 0;
    const issue = x.invoiceDate.value ?? this.today();
    const credit = settlement.mode === 'credit';
    const due = settlement.mode === 'credit' ? (settlement.dueDate ?? addDays(issue, terms ?? 30)) : null;
    await tx.exec(`delete from transactions where document_id = $1 and status in ('draft', 'awaiting_owner')`, [doc.id]);
    const t = await tx.one<{ id: string }>(
      `insert into transactions (org_id, kind, status, contact_id, document_id, reference, issue_date, due_date, settlement, payment_method,
                                 category, open_item_side, net_cents, vat_cents, gross_cents, created_by)
       values ($1, 'purchase_invoice', 'draft', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [orgId, contactId, doc.id, x.invoiceNumber.value, issue, due, settlement.mode, settlement.mode === 'cash' ? settlement.method : null,
        category, credit ? 'payable' : null, net, vat, net + vat, userId],
    );
    await this.insertLine(tx, orgId, t.id, category, net, vat, !!normaliseVatNumber(x.supplierVatNumber.value), doc.flags, x.supplierName.value);
    return t.id;
  }

  private async insertLine(tx: Tx, orgId: string, transactionId: string, category: PurchaseCategoryKey, net: number, vat: number, supplierHasVat: boolean, flags: string[], description: string | null) {
    const account = await tx.one<{ id: string }>(`select id from accounts where org_id = $1 and system_tag = $2`, [orgId, PURCHASE_CATEGORIES[category].accountTag]);
    await tx.exec(
      `insert into lines (org_id, transaction_id, line_no, description, account_id, vat_code, net_cents, vat_cents) values ($1, $2, 1, $3, $4, $5, $6, $7)`,
      [orgId, transactionId, description, account.id, purchaseVatCode(category, vat, supplierHasVat, flags), net, vat],
    );
  }

  private async tryPost(tx: Tx, userId: string, docId: string, transactionId: string, category: PurchaseCategoryKey): Promise<{ posted: boolean; error?: string }> {
    try {
      await tx.savepoint('autopost', () =>
        this.ledger.postTransaction(tx, userId, transactionId, {
          today: this.today(),
          reverseChargeInputBlocked: PURCHASE_CATEGORIES[category].vat === 'reverse_charge_blocked',
        }),
      );
      await tx.exec(`update documents set status = 'posted' where id = $1`, [docId]);
      return { posted: true };
    } catch (e) {
      if (e instanceof DomainError || (e as { code?: string }).code === 'P0001') return { posted: false, error: e instanceof DomainError ? e.code : 'rule_violation' };
      throw e;
    }
  }
}
