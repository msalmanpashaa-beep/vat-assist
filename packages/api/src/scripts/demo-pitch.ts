/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatRs, PURCHASE_CATEGORY_KEYS } from '@vat-assist/shared';
import Stripe from 'stripe';
import { mockCheckoutCompletedEvent } from '../modules/payments/payments.service';
import { checkEnvText } from './config-check';
import { API, call, invoicePhoto, ownerLogin, snap, staffCredentials, staffLogin } from './http';

/**
 * The pitch demo, in presentation order: onboarding → snap invoice → extraction → posting → VAT Pot →
 * reviewer query → sign-off → Stripe payment → Twilio reminder → return builder → deploy.
 * Runs against a local API (development providers), narrates each step, and checks every number it shows.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const OUT = join(process.cwd(), 'demo-output');
const PHONE = '+23057100051';
const run = String(Date.now()).slice(-5);
let n = 0;
const step = (title: string) => console.log(`\n${String(++n).padStart(2, ' ')}. ${title}`);
const say = (line: string) => console.log(`    ${line}`);
const rs = (c: number) => formatRs(c, 'en');
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
}
const cat = (re: RegExp) => PURCHASE_CATEGORY_KEYS.find((k) => re.test(k))!;

async function uploadAs(token: string, orgId: string, name: string, bytes: Buffer, kind: string): Promise<any> {
  const u = await call('POST', `/orgs/${orgId}/documents/upload-url`, { token, body: { mimeType: 'image/jpeg', byteSize: bytes.length, source: 'camera', kind, originalFilename: name } });
  const form = new FormData();
  for (const [k, v] of Object.entries(u.upload.fields as Record<string, string>)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), name);
  const put = await fetch(u.upload.url, { method: 'POST', body: form });
  check(put.status < 300, `upload returned ${put.status}`);
  return call('POST', `/orgs/${orgId}/documents/${u.documentId}/complete`, { token });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const creds = staffCredentials();
  const staff = (role: string) => creds.staff.find((s) => s.role === role)!;
  console.log('VAT Assist pitch demo');

  step('Onboarding: the owner signs in by SMS code (Kreol) and sets up the shop');
  const owner = await ownerLogin(PHONE, 'mfe');
  const org = await call('POST', '/orgs', {
    token: owner,
    body: { legalName: 'Boutik Demo Ltd', tradingName: `Boutik Pitch ${run}`, legalForm: 'company', vatNumber: '99999904', filingFrequency: 'quarterly', startDate: '2026-07-01', defaultLocale: 'mfe' },
  });
  const orgId = org.orgId as string;
  await call('POST', `/orgs/${orgId}/opening-balances`, {
    token: owner, body: { cashInHandCents: 1_500_000, bankBalances: [{ name: 'MCB current account', amountCents: 25_000_000 }], stockCents: 18_000_000, customersOwe: [], suppliersOwed: [] },
  });
  const admin = await staffLogin(staff('admin').email, staff('admin').password, staff('admin').totpSecret);
  for (const role of ['reviewer', 'senior_reviewer']) await call('POST', `/admin/orgs/${orgId}/staff`, { token: admin, body: { userId: staff(role).userId, role } });
  say(`Boutik Pitch ${run}: first return due ${org.dueStandard} (or ${org.dueElectronic} filed and paid online); referral code ${org.referralCode}`);
  say('opening balances recorded; a reviewer and a senior reviewer assigned');

  step('Snap an invoice: photographed on the phone, checked for sharpness and duplicates');
  const doc = await snap(owner, orgId, 'demo-grossiste-INV-0457.jpg', await invoicePhoto('GROSSISTE DEMO LTD - VAT INVOICE'));
  say(`uploaded and checked: ${doc.status}`);
  check(doc.status === 'awaiting_owner', 'a clear invoice waits for the two owner questions');

  step('Extraction: what was read, and how sure the system is');
  const x = doc.extraction;
  say(`${x.supplierName.value} (VAT ${x.supplierVatNumber.value}), invoice ${x.invoiceNumber.value} of ${x.invoiceDate.value}`);
  say(`net ${rs(x.netCents.value)} + VAT ${rs(x.vatCents.value)} = ${rs(x.totalCents.value)}; confidence ${Math.round(Number(doc.confidence) * 100)}%, flags: ${doc.flags.length ? doc.flags.join(', ') : 'none'}`);
  check(Number(doc.confidence) >= 0.85 && doc.flags.length === 0, 'confident read with nothing flagged');

  step('Posting: two taps ("on credit", "stock to resell") and it is in the books');
  const ans = await call('POST', `/orgs/${orgId}/documents/${doc.id}/answers`, { token: owner, body: { settlement: { mode: 'credit' }, category: cat(/stock|resale/) } });
  check(ans.outcome === 'posted', 'posted without a reviewer');
  await call('POST', `/orgs/${orgId}/daily-takings`, { token: owner, body: { date: '2026-09-12', lines: [{ method: 'cash', vatCode: 'SR', grossCents: 575_000 }, { method: 'juice', vatCode: 'SR', grossCents: 115_000 }] } });
  await call('POST', `/orgs/${orgId}/sales-invoices`, { token: owner, body: { customerName: 'Hotel Demo Ltd', issueDate: '2026-09-15', settlement: { mode: 'credit' }, lines: [{ description: 'Catering supplies', netCents: 400_000, vatCode: 'SR' }] } });
  const payables = await call('GET', `/orgs/${orgId}/ageing?side=payable&asOf=2026-10-01`, { token: owner });
  say(`purchase posted: owed to Grossiste Demo Ltd ${rs(payables.total)}, input VAT ${rs(x.vatCents.value)} claimable`);
  say('plus one day of takings (Rs 6,900 incl. VAT) and a credit invoice to Hotel Demo Ltd (Rs 4,600)');

  step('VAT Pot: what to set aside for MRA, live');
  const periods = await call('GET', `/orgs/${orgId}/periods`, { token: owner });
  const q3 = periods.find((p: any) => p.starts_on === '2026-07-01');
  const pot = await call('GET', `/orgs/${orgId}/vat-pot?periodId=${q3.id}`, { token: owner });
  say(`VAT on sales ${rs(pot.outputVatCents)} - VAT on purchases ${rs(pot.inputVatCents)} = set aside ${rs(pot.setAsideCents)}`);
  check(pot.outputVatCents === 150_000 && pot.inputVatCents === 60_000 && pot.setAsideCents === 90_000, 'VAT Pot = 1,500 - 600 = 900');

  step('Reviewer query: a receipt without a VAT number goes to the Chartered Accountant');
  const hand = await snap(owner, orgId, 'demo-handwritten-0012.jpg', await invoicePhoto('Ti Kanal Hardware'));
  const a2 = await call('POST', `/orgs/${orgId}/documents/${hand.id}/answers`, { token: owner, body: { settlement: { mode: 'cash', method: 'cash' }, category: cat(/repair|mainten/) } });
  check(a2.outcome === 'needs_review', 'missing supplier VAT number goes to review');
  const reviewer = await staffLogin(staff('reviewer').email, staff('reviewer').password, staff('reviewer').totpSecret);
  const q = await call('POST', `/orgs/${orgId}/queries`, { token: reviewer, body: { documentId: hand.id, body: 'No VAT number on this receipt, so its VAT cannot be claimed. Was the paint for the shop?' } });
  await call('POST', `/orgs/${orgId}/queries/${q.queryId}/messages`, { token: owner, body: { body: 'Wi, pou repint laboutik.' } });
  await call('POST', `/orgs/${orgId}/documents/${hand.id}/approve`, { token: reviewer, body: { corrections: {} } });
  await call('POST', `/orgs/${orgId}/queries/${q.queryId}/resolve`, { token: reviewer });
  say('reviewer asked, owner answered in Kreol, reviewer approved (VAT recorded as a cost) and closed the question');

  step('Sign-off: a draft from the ledger, signed by a senior reviewer, period locked');
  await call('POST', `/orgs/${orgId}/periods/${q3.id}/ready`, { token: owner });
  const draft = await call('POST', `/orgs/${orgId}/periods/${q3.id}/returns`, { token: reviewer });
  await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/sign-off`, { token: reviewer, expect: [403] });
  const senior = await staffLogin(staff('senior_reviewer').email, staff('senior_reviewer').password, staff('senior_reviewer').totpSecret);
  const signed = await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/sign-off`, { token: senior });
  say(`draft v${draft.version}: VAT payable ${rs(draft.figures.netPayable)}; reviewer cannot sign (403); senior signed, fingerprint ${signed.fingerprint.slice(0, 12)}...`);
  check(draft.figures.netPayable === 90_000, 'return payable equals the VAT Pot');

  step('Stripe payment: the Rs 25 deposit for the Nex-Gen onboarding call');
  const platformBefore = (await call('GET', `/orgs/${creds.platformOrgId}/vat-pot`, { token: admin })).outputVatCents as number;
  const booking = await call('POST', `/orgs/${orgId}/bookings`, { token: owner, body: { startsAt: '2026-10-08T10:00:00+04:00' } });
  const pay = await call('POST', `/pay/${booking.payUrl.split('/pay/')[1]}/card`);
  const paymentId = /dev\/card\/([0-9a-f-]{36})/.exec(pay.url)?.[1] as string;
  const payload = JSON.stringify(mockCheckoutCompletedEvent(`cs_mock_${paymentId}`, paymentId, creds.platformOrgId, 2500));
  const signature = new Stripe('sk_test_demo').webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dev_only_secret' });
  // Webhooks go out byte-for-byte: Stripe signs the exact body.
  const hook = (sig: string) => fetch(`${API}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
  check((await hook('t=1,v1=forged')).status === 400, 'a forged webhook is refused');
  check((await hook(signature)).status === 200, 'the signed webhook is accepted');
  const bookings = await call('GET', `/orgs/${orgId}/bookings`, { token: owner });
  const platformAfter = (await call('GET', `/orgs/${creds.platformOrgId}/vat-pot`, { token: admin })).outputVatCents as number;
  say(`checkout ${rs(booking.amountCents)} paid; forged webhook refused, signed one accepted; booking ${bookings[0].status}`);
  say(`Nex-Gen's own books: output VAT on the deposit ${rs(platformAfter - platformBefore)}`);
  check(bookings[0].status === 'confirmed' && platformAfter - platformBefore === 326, 'deposit confirmed with Rs 3.26 VAT');

  step('Twilio reminder: the evening before the 20 October deadline');
  const r = await call('POST', '/admin/reminders/run', { token: admin, body: { now: '2026-10-19T06:00:00Z' } });
  const sms = (await call('GET', `/dev/messages/outbox?to=${encodeURIComponent(PHONE)}`)).find((m: any) => m.body.includes(`Boutik Pitch ${run}`));
  say(`reminder run: ${r.queued} queued, ${r.sent} sent`);
  say(`SMS to ${PHONE}: "${sms?.body}"`);
  check(sms && sms.body.includes('20/10/2026'), 'the owner got the deadline reminder in Kreol');

  step('Return builder: guided filing, filing pack, MRA acknowledgement, payment, close');
  const guide = await call('GET', `/orgs/${orgId}/returns/${draft.returnId}/guide`, { token: owner });
  for (const g of guide.steps.filter((s: any) => s.amountCents !== undefined)) say(`${g.title}: ${rs(g.amountCents)}`);
  const pdf = Buffer.from(await (await fetch(`${API}/orgs/${orgId}/returns/${draft.returnId}/filing-pack.pdf`, { headers: { authorization: `Bearer ${owner}` } })).arrayBuffer());
  writeFileSync(join(OUT, 'pitch-filing-pack-Q3-2026.pdf'), pdf);
  check(pdf.subarray(0, 4).toString() === '%PDF', 'filing pack is a PDF');
  const ack = await uploadAs(owner, orgId, 'mra-ack.jpg', await invoicePhoto('MRA e-Services acknowledgement'), 'mra_acknowledgement');
  await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/acknowledgement`, { token: owner, body: { mraReference: `VATACK-PITCH-${run}`, documentId: ack.id } });
  await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/payment`, { token: owner, body: { paymentReference: `MCB-PITCH-${run}`, paidOn: '2026-10-19' } });
  await call('POST', `/orgs/${orgId}/periods/${q3.id}/close`, { token: reviewer });
  const final = (await call('GET', `/orgs/${orgId}/periods`, { token: owner })).find((p: any) => p.id === q3.id);
  say(`filing pack saved (demo-output/pitch-filing-pack-Q3-2026.pdf, ${Math.round(pdf.length / 1024)} KB); acknowledged, paid; Q3 is ${final.status}`);
  check(final.status === 'closed', 'period closed');

  step('Deploy: production settings checked, pipeline ready');
  const cfg = checkEnvText(readFileSync(join(ROOT, '.env.production.example'), 'utf8'), true);
  check(cfg.ok, `production template: ${[...cfg.missingKeys, ...cfg.invalid, ...cfg.providerGaps, ...cfg.productionProblems].join('; ')}`);
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml', 'packages/api/Dockerfile', 'apps/web/vercel.json']) check(existsSync(join(ROOT, f)), `${f} exists`);
  say(`.env.production.example passes every production rule; ${cfg.toFill.length} secrets to set on the hosts (${cfg.toFill.slice(0, 4).join(', ')}, ...)`);
  say('on merge to main: CI (types, unit, screen, end to end, SMTP) → migrations → API image → Vercel web → smoke tests');

  console.log('\nPitch demo finished: every check passed.');
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
