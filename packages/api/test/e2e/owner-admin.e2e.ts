/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  addDaysIso, autoAllocate, buildOpeningBalances, buildPayment, buildSalesInvoice, emptyOpeningForm, todayIn, WHATSAPP_CONSENT,
} from '@vat-assist/shared';
import { generate } from 'otplib';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, invoicePhoto, ownerLogin, snap, staffCredentials, staffLogin } from '../../src/scripts/http';

/**
 * The owner and admin screens, end to end against the running API, using the same request builders the
 * screens use (@vat-assist/shared forms). Each run creates its own shop, so it can be re-run on one database.
 */
const run = String(Date.now()).slice(-6);
const OWNER_PHONE = `+23057${run}`;
const today = todayIn('Indian/Mauritius');
const asMoney = (c: number) => (c / 100).toFixed(2);

let owner = '';
let admin = '';
let reviewer = '';
let orgId = '';
let invoiceId = '';
let creds: ReturnType<typeof staffCredentials>;
const role = (r: string) => creds.staff.find((s) => s.role === r)!;
const ageing = (side: string) => call('GET', `/orgs/${orgId}/ageing?side=${side}`, { token: owner });
const balance = async (tag: string) => (await call('GET', `/orgs/${orgId}/balances`, { token: owner })).find((b: any) => b.tag === tag).balance_cents;
const openItems = (contact: any) => contact.items.map((i: any) => ({ transactionId: i.transactionId, reference: i.reference, issueDate: i.issueDate, outstandingCents: i.outstandingCents }));

beforeAll(async () => {
  await call('GET', '/health');
  creds = staffCredentials();
  owner = await ownerLogin(OWNER_PHONE);
  admin = await staffLogin(role('admin').email, role('admin').password, role('admin').totpSecret);
  reviewer = await staffLogin(role('reviewer').email, role('reviewer').password, role('reviewer').totpSecret);
});

describe('owner screens: onboarding → snap → credit invoice → payments → ageing → reviewer query', () => {
  it('onboarding: business details, then opening balances from the form; they persist', async () => {
    orgId = (await call('POST', '/orgs', {
      token: owner,
      body: { legalName: 'Boutik Demo Ltd', tradingName: `E2E ${run}`, legalForm: 'company', vatNumber: '99999902', filingFrequency: 'quarterly', startDate: '2026-07-01' },
    })).orgId;
    const f = emptyOpeningForm();
    Object.assign(f, { cash: '15,000', stock: '180,000', banks: [{ name: 'MCB current', amount: '250,000' }] });
    f.customers = [{ name: 'Hotel Demo Ltd', amount: '1,200', date: '2026-05-10', phone: '5710 0021' }];
    f.suppliers = [{ name: 'Grossiste Demo Ltd', amount: '3,450', date: '2026-06-20' }];
    const built = buildOpeningBalances(f);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { totalAssetsCents: _a, totalOwedCents: _o, ...body } = built.value;
    await call('POST', `/orgs/${orgId}/opening-balances`, { token: owner, body });
    const saved = await call('GET', `/orgs/${orgId}/opening-balances`, { token: owner });
    expect(saved.recorded).toBe(true);
    expect(saved.openItems).toHaveLength(2);
    expect(await balance('bank')).toBe(25_000_000);
    expect(await balance('cash')).toBe(1_500_000);
    await call('POST', `/orgs/${orgId}/opening-balances`, { token: owner, body, expect: [409] });
  });

  it('snap a supplier bill bought on credit: it posts and joins payables', async () => {
    const d = await snap(owner, orgId, 'demo-grossiste-INV-0457.jpg', await invoicePhoto('GROSSISTE DEMO LTD INV-0457'));
    const a = await call('POST', `/orgs/${orgId}/documents/${d.id}/answers`, { token: owner, body: { settlement: { mode: 'credit' }, category: 'stock_for_resale' } });
    expect(a.outcome).toBe('posted');
    expect((await ageing('payable')).total).toBe(345_000 + 460_000);
  });

  it('create a credit invoice from the form: it lands in the 0-30 bucket', async () => {
    const r = buildSalesInvoice({
      customerName: 'Hotel Demo Ltd', customerPhone: '5710 0021', reminderConsent: true, issueDate: today, dueDate: addDaysIso(today, 30),
      lines: [{ description: 'Catering supplies', amount: '4,000', vatCode: 'SR' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { totals, ...body } = r.value;
    const inv = await call('POST', `/orgs/${orgId}/sales-invoices`, { token: owner, body });
    invoiceId = inv.transactionId;
    expect(inv.grossCents).toBe(totals.grossCents);
    const recv = await ageing('receivable');
    expect(recv.buckets).toMatchObject({ '0-30': 460_000, '90+': 120_000 });
    expect(recv.total).toBe(580_000);
  });

  it('record a customer payment by Juice: oldest first, partial on the new invoice; journal and ageing update', async () => {
    const hotel = (await ageing('receivable')).contacts.find((c: any) => c.contactName === 'Hotel Demo Ltd');
    const open = openItems(hotel);
    const alloc = autoAllocate(320_000, open);
    const p = buildPayment({ kind: 'receipt', contactId: hotel.contactId, date: today, method: 'juice', amount: '3,200', allocations: Object.fromEntries(alloc.map((x) => [x.invoiceId, asMoney(x.amountCents)])) }, open);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const { unallocatedCents, ...body } = p.value;
    expect(unallocatedCents).toBe(0);
    await call('POST', `/orgs/${orgId}/payments`, { token: owner, body });
    const after = await ageing('receivable');
    expect(after.total).toBe(260_000);
    expect(after.buckets['90+']).toBe(0);
    expect(await balance('juice_clearing')).toBe(320_000);
    const receipts = await call('GET', `/orgs/${orgId}/transactions?kind=receipt`, { token: owner });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('posted');
  });

  it('record a supplier payment by bank: supplier ageing and the bank balance both go down', async () => {
    const supplier = (await ageing('payable')).contacts.find((c: any) => c.contactName === 'Grossiste Demo Ltd');
    const open = openItems(supplier);
    const alloc = autoAllocate(805_000, open);
    const p = buildPayment({ kind: 'payment', contactId: supplier.contactId, date: today, method: 'bank', amount: '8,050', allocations: Object.fromEntries(alloc.map((x) => [x.invoiceId, asMoney(x.amountCents)])) }, open);
    if (!p.ok) throw new Error(p.errors.join('; '));
    const { unallocatedCents: _u, ...body } = p.value;
    await call('POST', `/orgs/${orgId}/payments`, { token: owner, body });
    expect((await ageing('payable')).total).toBe(0);
    expect(await balance('bank')).toBe(25_000_000 - 805_000);
  });

  it('reviewer query flow: assigned reviewer asks, owner answers, reviewer resolves', async () => {
    await call('POST', `/admin/orgs/${orgId}/staff`, { token: admin, body: { userId: role('reviewer').userId, role: 'reviewer' } });
    const portfolio = await call('GET', '/reviewer/portfolio', { token: reviewer });
    expect(portfolio.some((p: any) => p.orgId === orgId)).toBe(true);
    const q = await call('POST', `/orgs/${orgId}/queries`, { token: reviewer, body: { transactionId: invoiceId, body: 'Is the catering invoice for an event in October?', blocking: true } });
    await call('POST', `/orgs/${orgId}/queries/${q.queryId}/messages`, { token: owner, body: { body: 'Yes, the hotel’s staff party on 15 October.' } });
    const answered = await call('GET', `/orgs/${orgId}/queries/${q.queryId}`, { token: reviewer });
    expect(answered.status).toBe('answered');
    await call('POST', `/orgs/${orgId}/queries/${q.queryId}/resolve`, { token: reviewer });
    expect((await call('GET', `/orgs/${orgId}/queries/${q.queryId}`, { token: owner })).status).toBe('resolved');
  });
});

describe('reminder and WhatsApp toggles', () => {
  it('switching invoice reminders on schedules them; new invoices are scheduled by the background job; off cancels', async () => {
    const on = await call('PATCH', `/orgs/${orgId}/settings`, { token: owner, body: { debtorRemindersEnabled: true } });
    expect(on).toMatchObject({ debtorRemindersEnabled: true, scheduled: 1, scheduledInvoiceReminders: 1 });
    const queued = await call('GET', `/orgs/${orgId}/reminders?status=queued`, { token: owner });
    expect(queued[0]).toMatchObject({ template_key: 'invoice_due_tomorrow', to_e164: '+23057100021' });
    expect(queued[0].scheduled_for.slice(0, 10)).toBe(addDaysIso(addDaysIso(today, 30), -1));
    const second = buildSalesInvoice({ customerName: 'Hotel Demo Ltd', reminderConsent: false, issueDate: today, dueDate: addDaysIso(today, 20), lines: [{ description: 'Delivery', amount: '500', vatCode: 'SR' }] });
    if (!second.ok) throw new Error(second.errors.join('; '));
    const { totals: _t, ...body } = second.value;
    await call('POST', `/orgs/${orgId}/sales-invoices`, { token: owner, body });
    expect((await call('GET', `/orgs/${orgId}/settings`, { token: owner })).scheduledInvoiceReminders).toBe(2);
    const off = await call('PATCH', `/orgs/${orgId}/settings`, { token: owner, body: { debtorRemindersEnabled: false } });
    expect(off).toMatchObject({ debtorRemindersEnabled: false, cancelled: 2, scheduledInvoiceReminders: 0 });
    const again = await call('PATCH', `/orgs/${orgId}/settings`, { token: owner, body: { debtorRemindersEnabled: true } });
    expect(again.scheduledInvoiceReminders).toBe(2);
  });

  it('WhatsApp opt-in needs the current consent wording and is stored', async () => {
    await call('POST', `/orgs/${orgId}/whatsapp-consent`, { token: owner, body: { optIn: true, consentVersion: 'old-wording' }, expect: [409] });
    await call('POST', `/orgs/${orgId}/whatsapp-consent`, { token: owner, body: { optIn: true, consentVersion: WHATSAPP_CONSENT.version } });
    expect(await call('GET', `/orgs/${orgId}/settings`, { token: owner })).toMatchObject({ whatsappOptIn: true, whatsappConsentVersion: WHATSAPP_CONSENT.version });
    await call('POST', `/orgs/${orgId}/whatsapp-consent`, { token: owner, body: { optIn: false, consentVersion: WHATSAPP_CONSENT.version } });
    expect((await call('GET', `/orgs/${orgId}/settings`, { token: owner })).whatsappOptIn).toBe(false);
  });
});

describe('admin console', () => {
  const email = `e2e.${run}@nexgen.test`;
  let newUserId = '';

  it('invite a reviewer by email; they set a password, then an authenticator', async () => {
    const inv = await call('POST', '/admin/staff', { token: admin, body: { email, fullName: `E2E Reviewer ${run}`, role: 'reviewer' } });
    newUserId = inv.userId;
    await call('POST', '/auth/staff/login', { body: { email, password: 'Reviewer-E2E-2026!' }, expect: [401] });
    expect(inv.email.status).toBe('sent');
    const [mail] = await call('GET', `/dev/mail/outbox?to=${encodeURIComponent(email)}`);
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)![1] as string;
    const acc = await call('POST', '/auth/staff/invite/accept', { body: { token, password: 'Reviewer-E2E-2026!' } });
    expect(acc.totpEnrolled).toBe(false);
    const setup = await call('POST', '/auth/staff/totp/setup', { headers: { authorization: `Bearer ${acc.mfaToken}` } });
    const session = await call('POST', '/auth/staff/totp/verify', { body: { code: await generate({ secret: setup.secret }) }, headers: { authorization: `Bearer ${acc.mfaToken}` } });
    expect(session.accessToken).toBeTruthy();
    await call('POST', '/auth/staff/invite/accept', { body: { token, password: 'Another-Pass-2026!' }, expect: [400] });
    (globalThis as any).e2eSecret = setup.secret;
  });

  it('assign, bulk-reassign and unassign clients', async () => {
    const find = async () => (await call('GET', '/admin/clients', { token: admin })).find((c: any) => c.org_id === orgId);
    await call('POST', `/admin/orgs/${orgId}/staff`, { token: admin, body: { userId: newUserId, role: 'reviewer' } });
    expect((await find()).staff.some((s: any) => s.userId === newUserId)).toBe(true);
    const senior = role('senior_reviewer').userId;
    await call('POST', '/admin/assignments/bulk', { token: admin, body: { orgIds: [orgId], toUserId: senior, role: 'senior_reviewer', fromUserId: newUserId } });
    const after = await find();
    expect(after.staff.some((s: any) => s.userId === newUserId)).toBe(false);
    expect(after.staff.some((s: any) => s.userId === senior && s.role === 'senior_reviewer')).toBe(true);
    expect((await call('DELETE', `/admin/orgs/${orgId}/staff/${senior}`, { token: admin })).removed).toBe(1);
  });

  it('reset 2FA, re-enrol, then sign in with an admin-issued recovery code (once)', async () => {
    await call('POST', `/admin/staff/${newUserId}/reset-2fa`, { token: admin });
    const listed = (await call('GET', '/admin/staff', { token: admin })).find((s: any) => s.user_id === newUserId);
    expect(listed.totp_enabled).toBe(false);
    const l1 = await call('POST', '/auth/staff/login', { body: { email, password: 'Reviewer-E2E-2026!' } });
    expect(l1.totpEnrolled).toBe(false);
    const setup = await call('POST', '/auth/staff/totp/setup', { headers: { authorization: `Bearer ${l1.mfaToken}` } });
    await call('POST', '/auth/staff/totp/verify', { body: { code: await generate({ secret: setup.secret }) }, headers: { authorization: `Bearer ${l1.mfaToken}` } });
    const { code } = await call('POST', `/admin/staff/${newUserId}/recovery-code`, { token: admin });
    expect(code).toMatch(/^[2-9A-HJ-KM-NP-Z]{5}-[2-9A-HJ-KM-NP-Z]{5}$/);
    const l2 = await call('POST', '/auth/staff/login', { body: { email, password: 'Reviewer-E2E-2026!' } });
    expect((await call('POST', '/auth/staff/totp/verify', { body: { code }, headers: { authorization: `Bearer ${l2.mfaToken}` } })).accessToken).toBeTruthy();
    const l3 = await call('POST', '/auth/staff/login', { body: { email, password: 'Reviewer-E2E-2026!' } });
    await call('POST', '/auth/staff/totp/verify', { body: { code }, headers: { authorization: `Bearer ${l3.mfaToken}` }, expect: [401] });
  });

  it('disable and re-enable a staff account; non-admins are refused', async () => {
    await call('POST', `/admin/staff/${newUserId}/disable`, { token: admin });
    await call('POST', '/auth/staff/login', { body: { email, password: 'Reviewer-E2E-2026!' }, expect: [401, 403] });
    await call('POST', `/admin/staff/${newUserId}/enable`, { token: admin });
    await call('POST', '/auth/staff/login', { body: { email, password: 'Reviewer-E2E-2026!' } });
    await call('GET', '/admin/staff', { token: reviewer, expect: [403] });
    await call('POST', `/admin/staff/${role('admin').userId}/disable`, { token: admin, expect: [400, 409] });
  });

  it('feature flags per business: switching credit invoices off blocks the screen and the API', async () => {
    const flags = await call('PUT', `/admin/orgs/${orgId}/features`, { token: admin, body: { features: { credit_invoices: false } } });
    expect(flags.credit_invoices).toBe(false);
    expect((await call('GET', `/orgs/${orgId}/features`, { token: owner })).credit_invoices).toBe(false);
    const r = buildSalesInvoice({ customerName: 'Hotel Demo Ltd', reminderConsent: false, issueDate: today, dueDate: addDaysIso(today, 10), lines: [{ description: 'x', amount: '10', vatCode: 'SR' }] });
    if (!r.ok) throw new Error('form');
    const { totals: _t, ...body } = r.value;
    await call('POST', `/orgs/${orgId}/sales-invoices`, { token: owner, body, expect: [403] });
    await call('PUT', `/admin/orgs/${orgId}/features`, { token: admin, body: { features: { credit_invoices: true, invoice_reminders: false } } });
    expect((await call('GET', `/orgs/${orgId}/settings`, { token: owner })).scheduledInvoiceReminders).toBe(0);
    await call('PATCH', `/orgs/${orgId}/settings`, { token: owner, body: { debtorRemindersEnabled: true }, expect: [403] });
  });
});
