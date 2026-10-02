import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type ExtractedInvoice, type FilingFrequency, normaliseVatNumber, periodBounds, todayIn } from '@vat-assist/shared';
import { AppConfig } from '../../config';
import { sha256Hex } from '../../common/crypto';
import { Db, type Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { JobsService } from '../core/jobs.service';
import { RulesService } from '../core/rules.service';
import { StorageService } from '../core/storage.service';
import { runChecks } from './checks';
import { AnthropicExtractionProvider } from './extraction/anthropic.provider';
import { MockExtractionProvider } from './extraction/mock.provider';
import type { ExtractionProvider } from './extraction/provider';
import { dHash, NEAR_DUPLICATE_MAX_BITS } from './fingerprint';
import { checkImageQuality, checkPdfBasic } from './quality';
import { scoreExtraction } from './scoring';

interface DocRow {
  id: string;
  org_id: string;
  kind: string;
  mime_type: string;
  storage_key: string;
  original_filename: string | null;
  status: string;
}

/**
 * The ingestion pipeline: quality → exact duplicate (SHA-256) → near duplicate (perceptual hash) →
 * AI extraction → business-key duplicate → compliance checks → confidence score. Idempotent per document.
 */
@Injectable()
export class DocumentProcessor implements OnModuleInit {
  private readonly log = new Logger('DocumentProcessor');
  readonly provider: ExtractionProvider;

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly rules: RulesService,
  ) {
    this.provider =
      cfg.env.EXTRACTION_PROVIDER === 'anthropic'
        ? new AnthropicExtractionProvider(cfg.env.ANTHROPIC_API_KEY ?? '', cfg.env.EXTRACTION_MODEL)
        : new MockExtractionProvider();
  }

  onModuleInit(): void {
    this.jobs.register('document.process', (d) => this.process(String(d.orgId), String(d.documentId)));
  }

  async process(orgId: string, documentId: string): Promise<void> {
    const ctx = { kind: 'system', orgId } as const;
    const doc = await this.db.run(ctx, (tx) =>
      tx.maybe<DocRow>(`select id, org_id, kind, mime_type, storage_key, original_filename, status from documents where id = $1`, [documentId]),
    );
    if (!doc || doc.status !== 'processing') return;
    const bytes = await this.storage.get(doc.storage_key);
    const isImage = doc.mime_type.startsWith('image/');
    const extractable = doc.kind === 'purchase_invoice';

    // 1. Quality — only for invoices; acknowledgements and proofs are stored as evidence.
    const quality = isImage ? (extractable ? await checkImageQuality(bytes) : { ok: true, issues: [] }) : checkPdfBasic(bytes);
    if (!quality.ok) {
      await this.db.run(ctx, async (tx) => {
        await tx.exec(`update documents set status = 'rejected_quality', quality = $2, flags = $3, processed_at = now() where id = $1`, [doc.id, JSON.stringify(quality), quality.issues]);
        await this.audit.log(tx, 'document.rejected_quality', 'document', doc.id, { issues: quality.issues });
      });
      return;
    }

    // 2. Exact duplicate.
    const sha = sha256Hex(bytes);
    const hash = isImage ? await dHash(bytes) : null;
    const duplicate = await this.db.run(ctx, async (tx) => {
      const exact = await tx.maybe<{ id: string }>(
        `select id from documents where org_id = $1 and sha256 = $2 and id <> $3 and status <> 'duplicate' limit 1`,
        [orgId, sha, doc.id],
      );
      if (exact) {
        await this.markDuplicate(tx, doc.id, exact.id, sha);
        return true;
      }
      try {
        await tx.savepoint('fp', () =>
          tx.exec(`update documents set sha256 = $2, dhash = $3::bit(64), quality = $4 where id = $1`, [doc.id, sha, hash, JSON.stringify(quality)]),
        );
        return false;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e; // a twin was saved concurrently
        const twin = await tx.one<{ id: string }>(`select id from documents where org_id = $1 and sha256 = $2 and status <> 'duplicate' limit 1`, [orgId, sha]);
        await this.markDuplicate(tx, doc.id, twin.id, sha);
        return true;
      }
    });
    if (duplicate) return;

    if (!extractable) {
      await this.db.run(ctx, async (tx) => {
        await tx.exec(`update documents set status = 'archived', processed_at = now() where id = $1`, [doc.id]);
        await this.audit.log(tx, 'document.stored', 'document', doc.id, { kind: doc.kind });
      });
      return;
    }

    // 3. Near duplicates (another photo of the same paper).
    const near = hash
      ? await this.db.run(ctx, (tx) =>
          tx.many<{ id: string }>(
            `select id from documents where org_id = $1 and id <> $2 and dhash is not null
               and status not in ('duplicate', 'rejected_quality') and created_at > now() - interval '400 days'
               and bit_count(dhash # $3::bit(64)) <= $4`,
            [orgId, doc.id, hash, NEAR_DUPLICATE_MAX_BITS],
          ),
        )
      : [];

    // 4. Extraction.
    let x: ExtractedInvoice;
    try {
      const org = await this.db.run(ctx, (tx) => tx.one<{ legal_name: string; vat_number: string | null }>(`select legal_name, vat_number from organisations where id = $1`, [orgId]));
      x = await this.provider.extract({ bytes, mimeType: doc.mime_type, originalFilename: doc.original_filename, orgLegalName: org.legal_name, orgVatNumber: org.vat_number });
    } catch (e) {
      this.log.error(`extraction failed for ${doc.id}: ${(e as Error).message}`);
      await this.db.run(ctx, async (tx) => {
        await tx.exec(`update documents set status = 'failed', flags = array['extraction_failed'], processed_at = now() where id = $1`, [doc.id]);
        await this.audit.log(tx, 'document.extraction_failed', 'document', doc.id, { provider: this.provider.name });
      });
      if (!this.jobs.inline) throw e; // let the queue retry
      return;
    }

    // 5. Checks, score, save.
    await this.db.run(ctx, async (tx) => {
      const org = await tx.one<{ legal_name: string; trading_name: string | null; vat_number: string | null; start_date: string; filing_frequency: FilingFrequency }>(
        `select legal_name, trading_name, vat_number, start_date, filing_frequency from organisations where id = $1`,
        [orgId],
      );
      const today = todayIn(this.cfg.env.TZ_BUSINESS);
      const supplierVat = normaliseVatNumber(x.supplierVatNumber.value);
      const mraListLoaded = !!(await tx.maybe(`select 1 from mra_registered_persons limit 1`));
      const onList = supplierVat && mraListLoaded ? !!(await tx.maybe(`select 1 from mra_registered_persons where vat_number = $1`, [supplierVat])) : null;
      const duplicateOf = await this.businessKeyDuplicate(tx, orgId, doc.id, x, supplierVat);
      // A perceptual-hash match alone is not enough: one supplier's invoices share a template. Count it only
      // when the earlier document also reads the same total, number or date (another photo of the same paper).
      const nearSameContent = near.length
        ? await tx.many<{ id: string }>(
            `select id from documents where id = any($1::uuid[]) and (
               ($2::bigint is not null and (extraction->'totalCents'->>'value')::bigint = $2::bigint)
               or ($3::text is not null and upper(extraction->'invoiceNumber'->>'value') = upper($3::text))
               or ($4::text is not null and extraction->'invoiceDate'->>'value' = $4::text))`,
            [near.map((n) => n.id), x.totalCents.value, x.invoiceNumber.value, x.invoiceDate.value],
          )
        : [];
      const flags = runChecks(x, {
        orgNames: [org.legal_name, org.trading_name].filter((n): n is string => !!n),
        orgVatNumber: org.vat_number,
        today,
        booksStart: org.start_date,
        claimWindowMonths: await this.rules.claimWindowMonths(tx, today),
        invoicePeriodEnd: x.invoiceDate.value ? periodBounds(org.filing_frequency, x.invoiceDate.value).endsOn : null,
        standardRateBp: await this.rules.standardRateBp(tx, x.invoiceDate.value ?? today),
        duplicateOf,
        nearDuplicateIds: nearSameContent.map((n) => n.id),
        mraListLoaded,
        supplierOnMraList: onList,
      });
      const scored = scoreExtraction(x, flags, this.cfg.env.REVIEW_THRESHOLD);
      await tx.exec(
        `update documents set extraction = $2, extraction_provider = $3, confidence = $4, flags = $5, status = 'awaiting_owner', processed_at = now() where id = $1`,
        [doc.id, JSON.stringify({ ...x, checks: flags, route: scored.route }), this.provider.name, scored.score, flags.map((f) => f.code)],
      );
      await this.audit.log(tx, 'document.processed', 'document', doc.id, {
        provider: this.provider.name,
        confidence: scored.score,
        route: scored.route,
        flags: flags.map((f) => f.code),
      });
    });
  }

  private async markDuplicate(tx: Tx, id: string, of: string, sha: string): Promise<void> {
    await tx.exec(`update documents set status = 'duplicate', duplicate_of = $2, sha256 = $3, processed_at = now() where id = $1`, [id, of, sha]);
    await this.audit.log(tx, 'document.duplicate', 'document', id, { duplicateOf: of });
  }

  /** Same supplier + same invoice number, already in the books or waiting in the queue. */
  private async businessKeyDuplicate(tx: Tx, orgId: string, docId: string, x: ExtractedInvoice, supplierVat: string | null): Promise<string | null> {
    const number = x.invoiceNumber.value;
    const supplier = x.supplierName.value;
    if (!number || !supplier) return null;
    const inBooks = await tx.maybe<{ id: string }>(
      `select t.id from transactions t join contacts c on c.id = t.contact_id
       where t.org_id = $1 and t.kind = 'purchase_invoice' and t.status <> 'void' and upper(t.reference) = upper($2)
         and ((c.vat_number is not null and c.vat_number = $3) or c.name_normalised = app.normalise_name($4)) limit 1`,
      [orgId, number, supplierVat, supplier],
    );
    if (inBooks) return inBooks.id;
    const waiting = await tx.maybe<{ id: string }>(
      `select id from documents where org_id = $1 and id <> $2 and status in ('awaiting_owner', 'needs_review', 'posted')
         and upper(extraction->'invoiceNumber'->>'value') = upper($3)
         and app.normalise_name(extraction->'supplierName'->>'value') = app.normalise_name($4) limit 1`,
      [orgId, docId, number, supplier],
    );
    return waiting?.id ?? null;
  }
}
