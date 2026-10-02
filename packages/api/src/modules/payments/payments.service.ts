import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type CardCheckoutResponse, type ConfirmIncomingBody, formatRs, type PaymentRequestBody, type PaymentSettingsBody,
  type PayMethodInfo, type PayNotifyBody, type ProofUploadBody, type PublicPaymentRequest, splitGross, todayIn,
} from '@vat-assist/shared';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { z } from 'zod';
import { AppConfig } from '../../config';
import { type OrgScope, userCtx } from '../../common/auth-context';
import { safeEqual, sha256Hex } from '../../common/crypto';
import { DomainError, conflict, notFound } from '../../common/errors';
import { Db, type Tx } from '../../db/db.service';
import { RateLimiter } from '../auth/rate-limit';
import { AuditService } from '../core/audit.service';
import { RulesService } from '../core/rules.service';
import { StorageService } from '../core/storage.service';
import { findOrCreateContact } from '../ledger/contacts';
import { LedgerService } from '../ledger/ledger.service';
import { TransactionsService } from '../ledger/transactions.service';
import { RemindersService } from '../notifications/reminders.service';
import { CARD_GATEWAYS, type CardGateways } from './card';
import { MIPS_CLIENT, type MipsClient, type MipsImnData, MipsUnavailableError, MockMipsClient } from './mips';
import { newPayToken, newReference, RAIL_LABEL, RAIL_METHOD, type Rail } from './rails';

interface PaymentRow {
  id: string;
  org_id: string;
  payer_org_id: string | null;
  payable_kind: 'invoice' | 'booking';
  payable_id: string;
  payer_name: string | null;
  amount_cents: number;
  status: string;
  provider: Rail;
  provider_session_id: string | null;
  payment_request_id: string | null;
}

interface RequestRow {
  id: string;
  org_id: string;
  payer_org_id: string | null;
  payable_kind: 'invoice' | 'booking';
  payable_id: string;
  reference: string;
  amount_cents: number;
  currency: string;
  payee_name: string;
  payer_name: string | null;
  description: string;
  status: 'open' | 'paid' | 'cancelled' | 'expired';
  expires_at: Date;
}

interface SettingsRow {
  juice_mobile: string | null;
  juice_name: string | null;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_iban: string | null;
  qr_document_id: string | null;
  card_provider: 'mips' | 'stripe' | null;
}

const SETTINGS_COLUMNS = {
  juiceMobile: 'juice_mobile', juiceName: 'juice_name', bankName: 'bank_name', bankAccountName: 'bank_account_name',
  bankAccountNumber: 'bank_account_number', bankIban: 'bank_iban', qrDocumentId: 'qr_document_id', cardProvider: 'card_provider',
} as const;
const PROOF_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/**
 * Getting paid in Mauritius: a pay link per invoice or booking, payable by card (MIPS or Stripe, confirmed by
 * the provider) or by Juice / bank transfer (claimed by the payer, confirmed by the payee). Every confirmed
 * payment posts a receipt against the invoice, or Nex-Gen's VAT-inclusive deposit for a booking.
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger('Payments');
  private readonly stripeVerifier: Stripe;
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly books: TransactionsService,
    private readonly ledger: LedgerService,
    private readonly rules: RulesService,
    private readonly storage: StorageService,
    private readonly reminders: RemindersService,
    @Inject(CARD_GATEWAYS) private readonly cards: CardGateways,
    @Inject(MIPS_CLIENT) private readonly mips: MipsClient,
  ) {
    this.stripeVerifier = new Stripe(cfg.env.STRIPE_SECRET_KEY ?? 'sk_test_signature_checks_only');
  }

  private today() {
    return todayIn(this.cfg.env.TZ_BUSINESS);
  }

  // ---------- payee: settings ----------

  async getSettings(s: OrgScope) {
    return this.db.run(userCtx(s), async (tx) => {
      const r = await tx.maybe<SettingsRow>(`select * from payment_settings where org_id = $1`, [s.orgId]);
      return {
        juiceMobile: r?.juice_mobile ?? null, juiceName: r?.juice_name ?? null, bankName: r?.bank_name ?? null,
        bankAccountName: r?.bank_account_name ?? null, bankAccountNumber: r?.bank_account_number ?? null, bankIban: r?.bank_iban ?? null,
        qrDocumentId: r?.qr_document_id ?? null, cardProvider: r?.card_provider ?? null,
      };
    });
  }

  async putSettings(s: OrgScope, body: z.output<typeof PaymentSettingsBody>) {
    await this.db.run(userCtx(s), async (tx) => {
      if (body.qrDocumentId) {
        const d = await tx.maybe(`select 1 from documents where id = $1 and org_id = $2`, [body.qrDocumentId, s.orgId]);
        if (!d) throw notFound('QR code image');
      }
      await tx.exec(`insert into payment_settings (org_id) values ($1) on conflict (org_id) do nothing`, [s.orgId]);
      const sets: string[] = [];
      const values: unknown[] = [s.orgId];
      for (const [key, column] of Object.entries(SETTINGS_COLUMNS) as Array<[keyof typeof SETTINGS_COLUMNS, string]>) {
        if (body[key] === undefined) continue;
        values.push(body[key]);
        sets.push(`${column} = $${values.length}`);
      }
      values.push(s.userId);
      await tx.exec(`update payment_settings set ${[...sets, `updated_by = $${values.length}`, 'updated_at = now()'].join(', ')} where org_id = $1`, values);
      await this.audit.log(tx, 'payment_settings.updated', 'organisation', s.orgId, { fields: Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined) });
    });
    return this.getSettings(s);
  }

  // ---------- payee: requests ----------

  async createRequest(s: OrgScope, body: z.output<typeof PaymentRequestBody>) {
    return this.db.run(userCtx(s), (tx) => this.createRequestTx(tx, s, body));
  }

  private async createRequestTx(tx: Tx, s: OrgScope, body: z.output<typeof PaymentRequestBody>) {
    const me = await tx.one<{ name: string }>(`select coalesce(trading_name, legal_name) as name from organisations where id = $1`, [s.orgId]);
    let receiver = s.orgId;
    let payerOrg: string | null = null;
    let payeeName = me.name;
    let payerName: string | null;
    let description: string;
    let amount: number;
    if (body.payableKind === 'invoice') {
      const inv = await tx.maybe<{ kind: string; reference: string | null; outstanding_cents: number; customer: string | null }>(
        `select t.kind, t.reference, o.outstanding_cents, c.name as customer
         from transactions t join v_open_items o on o.transaction_id = t.id left join contacts c on c.id = t.contact_id
         where t.id = $1 and t.org_id = $2`,
        [body.payableId, s.orgId],
      );
      if (!inv || inv.kind !== 'sales_invoice' || inv.outstanding_cents <= 0) throw notFound('Unpaid sales invoice');
      amount = body.amountCents ?? inv.outstanding_cents;
      if (amount > inv.outstanding_cents) throw new DomainError('amount_too_high', `Only ${formatRs(inv.outstanding_cents)} is still owed on this invoice.`, 400);
      payerName = inv.customer;
      description = `Invoice ${inv.reference ?? ''} from ${me.name}`.replace(/\s+/g, ' ');
    } else {
      const b = await tx.maybe<{ status: string; platform_org_id: string }>(`select status, platform_org_id from bookings where id = $1 and org_id = $2`, [body.payableId, s.orgId]);
      if (!b) throw notFound('Booking');
      if (b.status !== 'pending_deposit') throw conflict('deposit_not_due', 'This booking does not need a deposit.');
      const platform = await tx.one<{ name: string }>(`select coalesce(trading_name, legal_name) as name from organisations where id = $1`, [b.platform_org_id]);
      receiver = b.platform_org_id;
      payerOrg = s.orgId;
      payeeName = platform.name;
      payerName = me.name;
      amount = body.amountCents ?? this.cfg.env.DEPOSIT_DEFAULT_CENTS;
      description = 'Deposit for your VAT Assist onboarding call (VAT included)';
    }
    const token = newPayToken();
    let row: { id: string; reference: string; expires_at: Date } | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      try {
        row = await tx.savepoint('payment_reference', () =>
          tx.one<{ id: string; reference: string; expires_at: Date }>(
            `insert into payment_requests (org_id, payer_org_id, payable_kind, payable_id, reference, token_hash, amount_cents,
                                           payee_name, payer_name, description, expires_at, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(days => $11), $12)
             returning id, reference, expires_at`,
            [receiver, payerOrg, body.payableKind, body.payableId, newReference(), sha256Hex(token), amount, payeeName, payerName, description, body.expiresInDays, s.userId],
          ),
        );
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e; // reference already used by this payee: draw another
      }
    }
    if (!row) throw new Error('could not allocate a payment reference');
    await this.audit.log(tx, 'payment_request.created', 'payment_request', row.id, { payableKind: body.payableKind, amountCents: amount, reference: row.reference });
    return { requestId: row.id, reference: row.reference, amountCents: amount, payUrl: `${this.cfg.env.WEB_BASE_URL}/pay/${token}`, expiresAt: row.expires_at };
  }

  async listRequests(s: OrgScope) {
    return this.db.run(userCtx(s), (tx) =>
      tx.many(
        `select id, payable_kind, payable_id, reference, amount_cents, payer_name, description, status, expires_at, created_at, paid_at
         from payment_requests where org_id = $1 or payer_org_id = $1 order by created_at desc limit 200`,
        [s.orgId],
      ),
    );
  }

  async createBooking(s: OrgScope, startsAt: string) {
    return this.db.run(userCtx(s), async (tx) => {
      const platform = await tx.maybe<{ id: string }>(`select id from organisations where is_platform`);
      if (!platform) throw new DomainError('platform_missing', 'The Nex-Gen platform organisation is missing. Run the seed.', 500);
      const b = await tx.one<{ id: string }>(
        `insert into bookings (org_id, platform_org_id, starts_at, created_by) values ($1, $2, $3, $4) returning id`,
        [s.orgId, platform.id, startsAt, s.userId],
      );
      await this.audit.log(tx, 'booking.created', 'booking', b.id, { startsAt });
      const request = await this.createRequestTx(tx, s, { payableKind: 'booking', payableId: b.id, expiresInDays: 7 });
      return { bookingId: b.id, ...request };
    });
  }

  async bookings(s: OrgScope) {
    return this.db.run(userCtx(s), (tx) =>
      tx.many(`select id, kind, starts_at, status, created_at from bookings where org_id = $1 order by starts_at desc`, [s.orgId]),
    );
  }

  // ---------- public pay link ----------

  private async resolveToken(token: string): Promise<{ id: string; orgId: string }> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('Payment link');
    const r = await this.db.run({ kind: 'system', orgId: null }, (tx) =>
      tx.maybe<{ id: string; org_id: string }>(`select * from app.payment_request_by_token($1)`, [sha256Hex(token)]),
    );
    if (!r) throw notFound('Payment link');
    return { id: r.id, orgId: r.org_id };
  }

  private assertPayable(r: RequestRow): void {
    if (r.status === 'paid') throw conflict('already_paid', 'This has already been paid. Thank you.');
    if (r.status !== 'open' || r.expires_at < new Date()) throw conflict('link_expired', 'This payment link has expired. Ask for a new one.');
  }

  async publicView(token: string, ip: string): Promise<PublicPaymentRequest> {
    this.limiter.hit(`pay-view:${ip}`, 120, 3_600_000);
    const { id, orgId } = await this.resolveToken(token);
    return this.db.run({ kind: 'system', orgId }, async (tx) => {
      const r = await tx.one<RequestRow>(`select * from payment_requests where id = $1`, [id]);
      const st = await tx.maybe<SettingsRow>(`select * from payment_settings where org_id = $1`, [orgId]);
      const pending = await tx.maybe(`select 1 from payments where payment_request_id = $1 and status = 'awaiting_confirmation'`, [id]);
      const methods: PayMethodInfo[] = [];
      if (st?.card_provider) methods.push({ kind: 'card', provider: st.card_provider });
      if (st?.juice_mobile) {
        const qr = st.qr_document_id ? await tx.maybe<{ storage_key: string }>(`select storage_key from documents where id = $1`, [st.qr_document_id]) : null;
        methods.push({ kind: 'juice', mobile: st.juice_mobile, name: st.juice_name, qrUrl: qr ? await this.storage.downloadUrl(qr.storage_key) : null });
      }
      if (st?.bank_account_number || st?.bank_iban) {
        methods.push({ kind: 'bank_transfer', bankName: st.bank_name, accountName: st.bank_account_name, accountNumber: st.bank_account_number, iban: st.bank_iban });
      }
      return {
        reference: r.reference,
        payeeName: r.payee_name,
        description: r.description,
        amountCents: r.amount_cents,
        currency: r.currency,
        status: r.status === 'open' && r.expires_at < new Date() ? 'expired' : r.status,
        expiresAt: r.expires_at.toISOString(),
        methods,
        pendingConfirmation: !!pending,
      };
    });
  }

  async startCard(token: string, ip: string): Promise<CardCheckoutResponse> {
    this.limiter.hit(`pay-card:${ip}`, 20, 3_600_000);
    const { id, orgId } = await this.resolveToken(token);
    return this.db.run({ kind: 'system', orgId }, async (tx) => {
      const r = await tx.one<RequestRow>(`select * from payment_requests where id = $1 for update`, [id]);
      this.assertPayable(r);
      const st = await tx.maybe<SettingsRow>(`select card_provider from payment_settings where org_id = $1`, [orgId]);
      if (!st?.card_provider) throw new DomainError('card_not_offered', 'Card payment is not offered here. Pay by Juice or bank transfer.', 400);
      const gateway = this.cards[st.card_provider];
      const { n } = await tx.one<{ n: number }>(`select count(*)::int as n from payments where payment_request_id = $1`, [id]);
      const orderRef = `${r.reference}-${String(n + 1).padStart(2, '0')}`;
      const p = await tx.one<{ id: string }>(
        `insert into payments (org_id, payer_org_id, payable_kind, payable_id, payer_name, amount_cents, provider, payment_request_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [orgId, r.payer_org_id, r.payable_kind, r.payable_id, r.payer_name, r.amount_cents, gateway.provider, r.id],
      );
      const co = await gateway.createCheckout({
        paymentId: p.id, orgId, orderRef, amountCents: r.amount_cents, description: r.description,
        returnUrl: `${this.cfg.env.WEB_BASE_URL}/pay/${token}?done=1`, cancelUrl: `${this.cfg.env.WEB_BASE_URL}/pay/${token}`,
      });
      await tx.exec(`update payments set provider_session_id = $2, checkout_url = $3 where id = $1`, [p.id, co.providerRef, co.kind === 'redirect' ? co.url : null]);
      await this.audit.log(tx, 'payment.checkout_created', 'payment', p.id, { provider: gateway.provider, amountCents: r.amount_cents, reference: r.reference });
      return co.kind === 'redirect' ? { kind: 'redirect', url: co.url } : { kind: 'html', html: co.html };
    });
  }

  async proofUpload(token: string, body: z.output<typeof ProofUploadBody>, ip: string) {
    this.limiter.hit(`pay-proof:${ip}`, 10, 3_600_000);
    const { id, orgId } = await this.resolveToken(token);
    return this.db.run({ kind: 'system', orgId }, async (tx) => {
      this.assertPayable(await tx.one<RequestRow>(`select * from payment_requests where id = $1`, [id]));
      const documentId = randomUUID();
      const key = `${orgId}/payment-proofs/${documentId}.${PROOF_EXT[body.mimeType]}`;
      await tx.exec(
        `insert into documents (id, org_id, kind, source, storage_key, mime_type, byte_size, original_filename, uploaded_by)
         values ($1, $2, 'payment_proof', 'web', $3, $4, $5, $6, null)`,
        [documentId, orgId, key, body.mimeType, body.byteSize, `payment-proof.${PROOF_EXT[body.mimeType]}`],
      );
      return { documentId, upload: await this.storage.presignUpload(key, body.mimeType, body.byteSize + 1024) };
    });
  }

  /** "I've paid": the payer sent money by Juice or bank transfer. The payee confirms once they see it. */
  async notifyPaid(token: string, body: z.output<typeof PayNotifyBody>, ip: string) {
    this.limiter.hit(`pay-notify:${ip}`, 10, 3_600_000);
    const { id, orgId } = await this.resolveToken(token);
    const result = await this.db.run({ kind: 'system', orgId }, async (tx) => {
      const r = await tx.one<RequestRow>(`select * from payment_requests where id = $1 for update`, [id]);
      this.assertPayable(r);
      const st = await tx.maybe<SettingsRow>(`select * from payment_settings where org_id = $1`, [orgId]);
      const offered = body.method === 'juice' ? !!st?.juice_mobile : !!(st?.bank_account_number || st?.bank_iban);
      if (!offered) throw new DomainError('method_not_offered', 'That way of paying is not offered here.', 400);
      if (await tx.maybe(`select 1 from payments where payment_request_id = $1 and status = 'awaiting_confirmation'`, [id])) {
        throw conflict('already_notified', 'You already told them about this payment. They will confirm it soon.');
      }
      let proofId: string | null = null;
      if (body.proofDocumentId) {
        const d = await tx.maybe<{ id: string; storage_key: string }>(
          `select id, storage_key from documents where id = $1 and org_id = $2 and kind = 'payment_proof'`,
          [body.proofDocumentId, orgId],
        );
        if (!d) throw notFound('Payment screenshot');
        if (!(await this.storage.exists(d.storage_key))) throw conflict('proof_missing', 'The screenshot did not finish uploading. Try again.');
        await tx.exec(`update documents set status = 'archived', processed_at = now() where id = $1`, [d.id]);
        proofId = d.id;
      }
      const payer = body.payerName ?? r.payer_name;
      const p = await tx.one<{ id: string }>(
        `insert into payments (org_id, payer_org_id, payable_kind, payable_id, payer_name, amount_cents, provider, status,
                               payment_request_id, payer_reference, proof_document_id, received_on)
         values ($1, $2, $3, $4, $5, $6, $7, 'awaiting_confirmation', $8, $9, $10, $11) returning id`,
        [orgId, r.payer_org_id, r.payable_kind, r.payable_id, payer, r.amount_cents, body.method, r.id, body.payerReference ?? null, proofId, body.paidOn],
      );
      await this.audit.log(tx, 'payment.claimed', 'payment', p.id, { method: body.method, amountCents: r.amount_cents, reference: r.reference, proof: !!proofId });
      await this.reminders.notifyOwners(tx, orgId, `claim:${p.id}`, 'payment_claimed', (locale) => ({
        payer: payer ?? 'A customer', amount: formatRs(r.amount_cents, locale), method: RAIL_LABEL[body.method][locale], reference: r.reference,
      }));
      return { paymentId: p.id, status: 'awaiting_confirmation' as const };
    });
    await this.reminders.dispatch(new Date()).catch((e: unknown) => this.log.warn(`could not send claim notice: ${String(e)}`));
    return result;
  }

  // ---------- payee: confirm or reject what payers say they sent ----------

  async incoming(s: OrgScope, status?: string) {
    return this.db.run(userCtx(s), async (tx) => {
      const rows = await tx.many<{ proof_key: string | null } & Record<string, unknown>>(
        `select p.id, p.provider, p.status, p.amount_cents, p.payer_name, p.payer_reference, p.received_on, p.created_at,
                p.confirmed_at, p.rejection_reason, r.reference, r.description, d.storage_key as proof_key
         from payments p left join payment_requests r on r.id = p.payment_request_id left join documents d on d.id = p.proof_document_id
         where p.org_id = $1 and ($2::text is null or p.status = $2) order by p.created_at desc limit 200`,
        [s.orgId, status ?? null],
      );
      return Promise.all(rows.map(async ({ proof_key, ...r }) => ({ ...r, proofUrl: proof_key ? await this.storage.downloadUrl(proof_key) : null })));
    });
  }

  async confirm(s: OrgScope, paymentId: string, body: z.output<typeof ConfirmIncomingBody>) {
    return this.db.run(userCtx(s), async (tx) => {
      const p = await tx.maybe<PaymentRow>(`select * from payments where id = $1 and org_id = $2 for update`, [paymentId, s.orgId]);
      if (!p) throw notFound('Payment');
      if (p.status !== 'awaiting_confirmation') throw conflict('not_awaiting', `This payment is ${p.status.replace('_', ' ')}.`);
      const transactionId = await this.settle(tx, s.orgId, s.userId, p, body.receivedOn);
      await tx.exec(
        `update payments set status = 'succeeded', confirmed_by = $2, confirmed_at = now(), completed_at = now(), received_on = $3,
                provider_payment_intent = $4, transaction_id = $5 where id = $1`,
        [p.id, s.userId, body.receivedOn, body.bankReference ?? null, transactionId],
      );
      const requestStatus = await this.closeRequestIfPaid(tx, p.payment_request_id);
      await this.audit.log(tx, 'payment.confirmed', 'payment', p.id, { method: p.provider, amountCents: p.amount_cents, receivedOn: body.receivedOn });
      return { paymentId: p.id, status: 'succeeded' as const, transactionId, requestStatus };
    });
  }

  async reject(s: OrgScope, paymentId: string, reason: string) {
    return this.db.run(userCtx(s), async (tx) => {
      const n = await tx.exec(
        `update payments set status = 'rejected', rejection_reason = $3 where id = $1 and org_id = $2 and status = 'awaiting_confirmation'`,
        [paymentId, s.orgId, reason],
      );
      if (!n) throw conflict('not_awaiting', 'Only a payment waiting for confirmation can be rejected.');
      await this.audit.log(tx, 'payment.rejected', 'payment', paymentId, { reason });
      return { paymentId, status: 'rejected' as const };
    });
  }

  /** Posts the money: a receipt against the invoice, or Nex-Gen's deposit for a booking. Returns the transaction. */
  private async settle(tx: Tx, orgId: string, userId: string | null, p: PaymentRow, date: string): Promise<string> {
    const method = RAIL_METHOD[p.provider] as 'juice' | 'bank' | 'stripe' | 'mips' | 'card';
    if (p.payable_kind === 'invoice') {
      const inv = await tx.one<{ contact_id: string }>(`select contact_id from transactions where id = $1`, [p.payable_id]);
      const open = await tx.maybe<{ outstanding_cents: number }>(`select outstanding_cents from v_open_items where transaction_id = $1`, [p.payable_id]);
      const allocate = Math.min(p.amount_cents, Math.max(0, open?.outstanding_cents ?? 0));
      const r = await this.books.recordPayment(tx, userId, orgId, {
        kind: 'receipt', contactId: inv.contact_id, date, method, amountCents: p.amount_cents,
        allocations: allocate > 0 ? [{ invoiceId: p.payable_id, amountCents: allocate }] : [],
      });
      return r.transactionId;
    }
    const id = await this.postBookingDeposit(tx, orgId, p, date, method);
    await tx.exec(`update bookings set status = 'confirmed' where id = $1`, [p.payable_id]);
    return id;
  }

  private async closeRequestIfPaid(tx: Tx, requestId: string | null): Promise<string | null> {
    if (!requestId) return null;
    const r = await tx.one<{ status: string; amount_cents: number; paid: number }>(
      `select r.status, r.amount_cents, coalesce((select sum(amount_cents) from payments where payment_request_id = r.id and status = 'succeeded'), 0)::bigint as paid
       from payment_requests r where r.id = $1 for update`,
      [requestId],
    );
    if (r.status === 'open' && r.paid >= r.amount_cents) {
      await tx.exec(`update payment_requests set status = 'paid', paid_at = now() where id = $1`, [requestId]);
      return 'paid';
    }
    return r.status;
  }

  /**
   * Nex-Gen's deposit is revenue received before the service: the payment is the time of supply, so
   * output VAT is due on it now (Rs 25.00 VAT-inclusive = Rs 21.74 + Rs 3.26 VAT).
   */
  private async postBookingDeposit(tx: Tx, platformOrgId: string, p: PaymentRow, date: string, method: 'juice' | 'bank' | 'stripe' | 'mips' | 'card'): Promise<string> {
    const contact = await findOrCreateContact(tx, platformOrgId, { name: p.payer_name ?? 'Client', kind: 'customer' });
    const platform = await tx.one<{ vat_number: string | null }>(`select vat_number from organisations where id = $1`, [platformOrgId]);
    const rate = await this.rules.standardRateBp(tx, date);
    const { net, vat } = platform.vat_number ? splitGross(p.amount_cents, rate) : { net: p.amount_cents, vat: 0 };
    const t = await tx.one<{ id: string }>(
      `insert into transactions (org_id, kind, contact_id, reference, issue_date, settlement, payment_method, net_cents, vat_cents, gross_cents)
       values ($1, 'deposit', $2, $3, $4, 'cash', $5, $6, $7, $8) returning id`,
      [platformOrgId, contact.id, `DEP-${p.payable_id.slice(0, 8).toUpperCase()}`, date, method, net, vat, net + vat],
    );
    await tx.exec(
      `insert into lines (org_id, transaction_id, line_no, description, vat_code, net_cents, vat_cents) values ($1, $2, 1, $3, $4, $5, $6)`,
      [platformOrgId, t.id, 'Onboarding call deposit', platform.vat_number ? 'SR' : 'OS', net, vat],
    );
    await this.ledger.postTransaction(tx, null, t.id, { today: this.today() });
    return t.id;
  }

  // ---------- provider callbacks ----------

  private async dedupe(provider: 'stripe' | 'mips', eventId: string, type: string): Promise<boolean> {
    const fresh = await this.db.run({ kind: 'system', orgId: null }, (tx) =>
      tx.maybe(
        `insert into webhook_events (provider, event_id, type) values ($1, $2, $3)
         on conflict (provider, event_id) do update set type = excluded.type where webhook_events.processed_at is null
         returning event_id`,
        [provider, eventId, type],
      ),
    );
    return !!fresh;
  }

  private async finishEvent(provider: 'stripe' | 'mips', eventId: string, error: string | null): Promise<void> {
    await this.db.run({ kind: 'system', orgId: null }, (tx) =>
      tx.exec(
        `update webhook_events set processed_at = case when $3::text is null then now() else processed_at end, error = $3
         where provider = $1 and event_id = $2`,
        [provider, eventId, error],
      ),
    );
  }

  /** Card success from Stripe or MIPS: checks amount and currency, then settles exactly once. */
  private async providerSucceeded(provider: 'stripe' | 'mips', paymentId: string, orgId: string, amountCents: number, currency: string, providerTxnId: string | null) {
    await this.db.run({ kind: 'system', orgId }, async (tx) => {
      const p = await tx.one<PaymentRow>(`select * from payments where id = $1 for update`, [paymentId]);
      if (p.status === 'succeeded') return;
      if (p.provider !== provider) throw new DomainError('provider_mismatch', `Payment ${paymentId} is not a ${provider} payment.`, 400);
      if (amountCents !== p.amount_cents || currency.toLowerCase() !== 'mur') {
        throw new DomainError('amount_mismatch', `${provider} reported ${amountCents} ${currency}, expected ${p.amount_cents} MUR.`, 400);
      }
      const transactionId = await this.settle(tx, orgId, null, p, this.today());
      await tx.exec(
        `update payments set status = 'succeeded', completed_at = now(), provider_payment_intent = $2, transaction_id = $3 where id = $1`,
        [p.id, providerTxnId, transactionId],
      );
      await this.closeRequestIfPaid(tx, p.payment_request_id);
      await this.audit.log(tx, 'payment.succeeded', 'payment', p.id, { provider, amountCents: p.amount_cents });
    });
  }

  private async runEvent(provider: 'stripe' | 'mips', eventId: string, work: () => Promise<void>) {
    try {
      await work();
      await this.finishEvent(provider, eventId, null);
      return { received: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.finishEvent(provider, eventId, message);
      // Permanent problems are acknowledged so the provider stops retrying; they stay logged for a reviewer.
      if (e instanceof DomainError && e.status < 500) {
        this.log.error(`${provider} event ${eventId} rejected: ${message}`);
        return { received: true, rejected: e.code };
      }
      throw e;
    }
  }

  async handleStripeWebhook(raw: Buffer | undefined, signature: string | undefined) {
    if (!raw) throw new DomainError('no_body', 'Empty webhook body.', 400);
    let event: Stripe.Event;
    try {
      event = this.stripeVerifier.webhooks.constructEvent(raw, signature ?? '', this.cfg.env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new DomainError('bad_signature', 'Stripe signature check failed.', 400);
    }
    if (!(await this.dedupe('stripe', event.id, event.type))) return { received: true, duplicate: true };
    return this.runEvent('stripe', event.id, async () => {
      if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return;
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== 'paid') return;
      const paymentId = session.metadata?.paymentId ?? '';
      const { org } = await this.db.run({ kind: 'system', orgId: null }, (tx) =>
        tx.one<{ org: string | null }>(`select app.payment_org($1::uuid) as org`, [/^[0-9a-f-]{36}$/i.test(paymentId) ? paymentId : null]),
      );
      if (!org) throw new DomainError('unknown_payment', `No payment ${paymentId}.`, 400);
      const intent = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null);
      await this.providerSucceeded('stripe', paymentId, org, session.amount_total ?? -1, session.currency ?? '', intent);
    });
  }

  /** MIPS IMN: only sent on success; decrypting it through MIPS with our keys proves it came from MIPS. */
  async handleMipsImn(body: unknown, raw: Buffer | undefined, pathSecret: string | undefined) {
    const secret = this.cfg.env.MIPS_IMN_PATH_SECRET;
    if (secret && !safeEqual(pathSecret ?? '', secret)) throw new NotFoundException();
    const crypted = extractCrypted(body, raw, this.cfg.env.MIPS_IMN_FIELD);
    if (!crypted) throw new DomainError('no_payload', 'Empty IMN.', 400);
    let data: MipsImnData;
    try {
      data = await this.mips.decryptImn(crypted);
    } catch (e) {
      if (e instanceof MipsUnavailableError) throw e;
      throw e instanceof DomainError ? e : new DomainError('imn_invalid', 'Could not decrypt the notification.', 400);
    }
    const eventId = `${data.id_order}:${data.transaction_id ?? data.status}`;
    if (!(await this.dedupe('mips', eventId, `imn.${data.status}`))) return { received: true, duplicate: true };
    return this.runEvent('mips', eventId, async () => {
      if (data.status !== 'success') return;
      const hit = await this.db.run({ kind: 'system', orgId: null }, (tx) =>
        tx.maybe<{ id: string; org_id: string }>(`select * from app.payment_by_provider_ref('mips', $1)`, [data.id_order]),
      );
      if (!hit) throw new DomainError('unknown_payment', `No MIPS order ${data.id_order}.`, 400);
      await this.providerSucceeded('mips', hit.id, hit.org_id, Math.round(Number(data.amount) * 100), data.currency, data.transaction_id ?? null);
    });
  }

  // ---------- development ----------

  /** Development only: send ourselves the callback Stripe or MIPS would send after a successful test card. */
  async simulateCardSuccess(paymentId: string) {
    if (this.cfg.isProduction || this.cfg.env.PAYMENTS_MODE !== 'mock') throw new NotFoundException();
    const { org } = await this.db.run({ kind: 'system', orgId: null }, (tx) => tx.one<{ org: string | null }>(`select app.payment_org($1::uuid) as org`, [paymentId]));
    if (!org) throw new NotFoundException();
    const p = await this.db.run({ kind: 'system', orgId: org }, (tx) => tx.one<PaymentRow>(`select * from payments where id = $1`, [paymentId]));
    if (p.provider === 'stripe') {
      const payload = JSON.stringify(mockCheckoutCompletedEvent(p.provider_session_id ?? '', p.id, org, p.amount_cents));
      const header = this.stripeVerifier.webhooks.generateTestHeaderString({ payload, secret: this.cfg.env.STRIPE_WEBHOOK_SECRET });
      return this.handleStripeWebhook(Buffer.from(payload), header);
    }
    if (p.provider === 'mips') {
      const crypted = MockMipsClient.encrypt(mockImn(p.provider_session_id ?? '', p.amount_cents));
      return this.handleMipsImn({ [this.cfg.env.MIPS_IMN_FIELD]: crypted }, undefined, this.cfg.env.MIPS_IMN_PATH_SECRET);
    }
    throw new DomainError('not_card', 'Only card payments can be simulated.', 400);
  }
}

/** Accepts the IMN as JSON or form field, or the whole body as the encrypted string. */
export function extractCrypted(body: unknown, raw: Buffer | undefined, field: string): string | null {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const k of [field, 'crypted_callback', 'received_crypted_data', 'data']) {
      const v = b[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  const text = raw?.toString('utf8').trim();
  return text ? text : null;
}

export function mockImn(idOrder: string, amountCents: number): MipsImnData {
  return { amount: (amountCents / 100).toFixed(2), currency: 'MUR', status: 'success', id_order: idOrder, transaction_id: `MIPSTEST${idOrder.replace(/\W/g, '')}`, payment_method: 'card' };
}

export function mockCheckoutCompletedEvent(sessionId: string, paymentId: string, orgId: string, amountCents: number) {
  return {
    id: `evt_mock_${paymentId.replace(/-/g, '')}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId, object: 'checkout.session', amount_total: amountCents, currency: 'mur', payment_status: 'paid',
        payment_intent: `pi_mock_${paymentId.slice(0, 8)}`, metadata: { paymentId, orgId },
      },
    },
  };
}
