/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatRs, PURCHASE_CATEGORY_KEYS } from '@vat-assist/shared';
import { generate } from 'otplib';
import sharp from 'sharp';
import Stripe from 'stripe';
import { MockMipsClient } from '../modules/payments/mips';
import { mockCheckoutCompletedEvent, mockImn } from '../modules/payments/payments.service';

/**
 * End-to-end demo against a running API (npm run dev:api). Plays every role through the real HTTP API:
 * owner on the phone, Nex-Gen admin, reviewer and senior reviewer. Stops on the first unexpected result.
 * All people, businesses and numbers are fictional.
 */
const API = process.env.DEMO_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const OUT = join(process.cwd(), 'demo-output');
const OWNER_PHONE = '+23057100001';
const OTHER_PHONE = '+23057100002';
const OTP = process.env.OTP_DEV_FIXED_CODE ?? '000000';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dev_only_secret';

let n = 0;
const step = (t: string) => console.log(`\n${String(++n).padStart(2, ' ')}. ${t}`);
const say = (t: string) => console.log(`    ${t}`);
const rs = (c: number) => formatRs(c, 'en');
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
}

async function call(method: string, path: string, o: { token?: string; body?: unknown; expect?: number[]; headers?: Record<string, string>; raw?: boolean } = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...o.headers,
    },
    body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
  });
  const ok = (o.expect ?? [200, 201, 202, 204]).includes(res.status);
  if (o.raw && ok) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  if (!ok) throw new Error(`${method} ${path} returned ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const cat = (re: RegExp) => {
  const k = PURCHASE_CATEGORY_KEYS.find((x) => re.test(x));
  if (!k) throw new Error(`no purchase category matches ${re}`);
  return k;
};

/** A synthetic A4 "photo" of a document: ruled lines and a dense block so the sharpness check has edges to measure. */
async function page(title: string, rows: string[], blur = false): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = [title, ...rows].map((r, i) => `<text x="80" y="${150 + i * 56}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${i ? 30 : 44}" fill="#111">${esc(r)}</text>`).join('');
  const rules = Array.from({ length: 22 }, (_, i) => `<line x1="70" x2="1170" y1="${170 + i * 56}" y2="${170 + i * 56}" stroke="#333" stroke-width="2"/>`).join('');
  const block = Array.from({ length: 400 }, (_, i) => ((i + Math.floor(i / 20)) % 2 ? '' : `<rect x="${860 + (i % 20) * 14}" y="${1380 + Math.floor(i / 20) * 14}" width="14" height="14" fill="#000"/>`)).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="1240" height="1754" fill="#fdfdf8"/><rect x="40" y="40" width="1160" height="1674" fill="none" stroke="#111" stroke-width="5"/>${rules}${text}${block}</svg>`;
  const img = sharp(Buffer.from(svg));
  return (blur ? img.blur(16) : img).jpeg({ quality: 86 }).toBuffer();
}

/** The presigned POST the phone (or the public pay page) uses to send a file straight to storage. */
async function toStorage(upload: { url: string; fields: Record<string, string> }, bytes: Buffer, name: string): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), name);
  const put = await fetch(upload.url, { method: 'POST', body: form });
  check(put.status === 204 || put.status === 201 || put.status === 200, `upload to storage returned ${put.status}: ${await put.text()}`);
}

const tokenOf = (payUrl: string) => payUrl.split('/pay/')[1] as string;

async function upload(token: string, orgId: string, name: string, bytes: Buffer, kind = 'purchase_invoice'): Promise<any> {
  const u = await call('POST', `/orgs/${orgId}/documents/upload-url`, { token, body: { mimeType: 'image/jpeg', byteSize: bytes.length, source: 'camera', kind, originalFilename: name } });
  await toStorage(u.upload, bytes, name);
  let doc = await call('POST', `/orgs/${orgId}/documents/${u.documentId}/complete`, { token });
  for (let i = 0; i < 40 && ['uploading', 'processing'].includes(doc.status); i++) {
    await new Promise((r) => setTimeout(r, 250));
    doc = await call('GET', `/orgs/${orgId}/documents/${u.documentId}`, { token });
  }
  return doc;
}

async function staffLogin(email: string, password: string, secret: string): Promise<string> {
  const l = await call('POST', '/auth/staff/login', { body: { email, password } });
  check(l.totpEnrolled, `${email} should have an authenticator set up`);
  const s = await call('POST', '/auth/staff/totp/verify', { body: { code: await generate({ secret }) }, headers: { authorization: `Bearer ${l.mfaToken}` } });
  return s.accessToken;
}

async function stripeEvent(sessionId: string, paymentId: string, orgId: string, amount: number) {
  const payload = JSON.stringify(mockCheckoutCompletedEvent(sessionId, paymentId, orgId, amount));
  const header = new Stripe('sk_test_demo').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const creds = JSON.parse(await readFile(join(OUT, 'staff-credentials.json'), 'utf8')) as {
    platformOrgId: string;
    staff: Array<{ email: string; password: string; role: string; userId: string; totpSecret: string }>;
  };
  const staff = (role: string) => creds.staff.find((s) => s.role === role)!;
  console.log(`VAT Assist demo against ${API}`);
  await call('GET', '/health');

  step('Shop owner signs in with an SMS code (Kreol chosen as language)');
  await call('POST', '/auth/otp/start', { body: { phone: OWNER_PHONE } });
  const owner = (await call('POST', '/auth/otp/verify', { body: { phone: OWNER_PHONE, code: OTP, locale: 'mfe' } })).accessToken as string;
  say(`signed in ${OWNER_PHONE}`);

  step('Onboarding: business details, then opening balances on the start date');
  const org = await call('POST', '/orgs', {
    token: owner,
    body: {
      legalName: 'Boutik Demo Ltd', tradingName: 'Boutik Demo', legalForm: 'company', brn: 'C26000001', vatNumber: '99999902',
      filingFrequency: 'quarterly', filesAndPaysElectronically: true, startDate: '2026-07-01', shopType: 'grocery', defaultLocale: 'fr',
    },
  });
  const orgId = org.orgId as string;
  say(`organisation ${orgId}; first period due ${org.dueStandard} (electronic ${org.dueElectronic})`);
  const opening = await call('POST', `/orgs/${orgId}/opening-balances`, {
    token: owner,
    body: {
      cashInHandCents: 1_500_000, bankBalances: [{ name: 'MCB current account', amountCents: 25_000_000 }], stockCents: 18_000_000,
      customersOwe: [{ name: 'Hotel Demo Ltd', amountCents: 120_000, date: '2026-05-10' }],
      suppliersOwed: [{ name: 'Grossiste Demo Ltd', amountCents: 345_000, date: '2026-06-20' }],
    },
  });
  say(`opening journal entry #${opening.entryNo}, ${opening.openItems} open items carried into ageing`);

  step('Nex-Gen admin signs in (password + authenticator) and assigns a reviewer and a senior reviewer');
  const admin = await staffLogin(staff('admin').email, staff('admin').password, staff('admin').totpSecret);
  await call('POST', `/admin/orgs/${orgId}/staff`, { token: admin, body: { userId: staff('reviewer').userId, role: 'reviewer' } });
  await call('POST', `/admin/orgs/${orgId}/staff`, { token: admin, body: { userId: staff('senior_reviewer').userId, role: 'senior_reviewer' } });
  say('assigned reviewer@nexgen.test and senior@nexgen.test');

  step('Owner photographs purchase invoices; the pipeline checks quality, duplicates and reads them');
  const grossiste = await page('GROSSISTE DEMO LTD - VAT INVOICE', ['VAT No 27999902', 'Invoice INV-0457   03/08/2026', 'Bill to: Boutik Demo Ltd', 'Rice, oil, flour', 'Net Rs 4,000.00', 'VAT 15% Rs 600.00', 'Total Rs 4,600.00']);
  const d1 = await upload(owner, orgId, 'demo-grossiste-INV-0457.jpg', grossiste);
  say(`INV-0457: ${d1.status}, confidence ${d1.confidence}, flags [${(d1.flags ?? []).join(', ')}]`);
  check(d1.status === 'awaiting_owner', 'clear invoice should wait for the two owner answers');
  const a1 = await call('POST', `/orgs/${orgId}/documents/${d1.id}/answers`, { token: owner, body: { settlement: { mode: 'credit' }, category: cat(/stock|resale/) } });
  say(`answered "on credit, stock": ${a1.outcome}`);
  check(a1.outcome === 'posted', 'high-confidence invoice should post automatically');

  const power = await page('ISLAND POWER DEMO LTD - VAT INVOICE', ['VAT No 27999903', 'Bill BILL-88231   28/08/2026', 'Customer: Boutik Demo Ltd', 'Electricity August', 'Net Rs 2,600.00', 'VAT Rs 390.00', 'Total Rs 2,990.00']);
  const d2 = await upload(owner, orgId, 'demo-power-BILL-88231.jpg', power);
  const a2 = await call('POST', `/orgs/${orgId}/documents/${d2.id}/answers`, { token: owner, body: { settlement: { mode: 'cash', method: 'bank' }, category: cat(/utilit|electric/) } });
  say(`BILL-88231: answered "paid by bank, utilities": ${a2.outcome}`);
  check(a2.outcome === 'posted', 'utility bill should post');

  const hand = await page('Ti Kanal Hardware', ['Recu 0012   10/09/2026', 'Peinture et pinceaux', 'Total Rs 1,150 (dont TVA 150)']);
  const d3 = await upload(owner, orgId, 'demo-handwritten-0012.jpg', hand);
  const a3 = await call('POST', `/orgs/${orgId}/documents/${d3.id}/answers`, { token: owner, body: { settlement: { mode: 'cash', method: 'cash' }, category: cat(/repair|mainten/) } });
  say(`handwritten receipt: ${a3.outcome} because [${a3.reasons.join(', ')}]`);
  check(a3.outcome === 'needs_review', 'receipt without a supplier VAT number must go to a reviewer');

  const dup = await upload(owner, orgId, 'demo-grossiste-INV-0457.jpg', grossiste);
  say(`same invoice uploaded again: ${dup.status}`);
  check(dup.status === 'duplicate', 'exact re-upload must be caught as a duplicate');
  const blurry = await upload(owner, orgId, 'blurry-photo.jpg', await page('GROSSISTE DEMO LTD', ['Invoice INV-0460', 'Total Rs 999.00'], true));
  say(`blurred photo: ${blurry.status} [${(blurry.quality?.issues ?? []).join(', ')}]`);
  check(blurry.status === 'rejected_quality', 'blurred photo must be rejected with a retake request');

  step('Sales: one day of takings and one invoice on credit');
  await call('POST', `/orgs/${orgId}/daily-takings`, {
    token: owner,
    body: { date: '2026-09-12', lines: [
      { method: 'cash', vatCode: 'SR', grossCents: 575_000 }, { method: 'juice', vatCode: 'SR', grossCents: 115_000 },
      { method: 'cash', vatCode: 'ZR', grossCents: 80_000 }, { method: 'card', vatCode: 'EX', grossCents: 20_000 },
    ] },
  });
  say('takings 12/09: Rs 6,900 standard-rated (VAT Rs 900 inside), Rs 800 zero-rated, Rs 200 exempt');
  const inv = await call('POST', `/orgs/${orgId}/sales-invoices`, {
    token: owner,
    body: { customerName: 'Hotel Demo Ltd', issueDate: '2026-09-15', settlement: { mode: 'credit' }, lines: [{ description: 'Catering supplies', netCents: 400_000, vatCode: 'SR' }] },
  });
  say(`invoice ${inv.reference}: ${rs(inv.grossCents)} due ${inv.dueDate}`);

  step('Owner sets how customers can pay: Juice, the MCB account, and cards through MIPS');
  await call('PUT', `/orgs/${orgId}/payment-settings`, {
    token: owner,
    body: {
      juiceMobile: '+23057100001', juiceName: 'Boutik Demo Ltd', bankName: 'MCB', bankAccountName: 'Boutik Demo Ltd',
      bankAccountNumber: '000 123 456 789', bankIban: 'MU17BOMM0101101030300200000MUR', cardProvider: 'mips',
    },
  });
  say('saved');

  step('Customer pays Rs 2,000 by Juice from the pay link, attaches the screenshot; the shop confirms');
  const req1 = await call('POST', `/orgs/${orgId}/payment-requests`, { token: owner, body: { payableKind: 'invoice', payableId: inv.transactionId, amountCents: 200_000 } });
  const t1 = tokenOf(req1.payUrl);
  const view1 = await call('GET', `/pay/${t1}`);
  say(`pay link shows ${rs(view1.amountCents)} to ${view1.payeeName}, reference ${view1.reference}; ways to pay: ${view1.methods.map((m: any) => (m.kind === 'card' ? `card (${m.provider})` : m.kind)).join(', ')}`);
  check(view1.methods.length === 3, 'card, Juice and bank transfer should all be offered');
  const shot = await page('Juice by MCB', ['Transfer successful', 'Rs 2,000.00 to Boutik Demo Ltd', `Reference ${view1.reference}`]);
  const proof = await call('POST', `/pay/${t1}/proof-upload`, { body: { mimeType: 'image/jpeg', byteSize: shot.length } });
  await toStorage(proof.upload, shot, 'juice-screenshot.jpg');
  const claim1 = await call('POST', `/pay/${t1}/notify`, {
    body: { method: 'juice', paidOn: '2026-09-30', payerName: 'Hotel Demo Ltd', payerReference: 'JUICE 4471-2209', proofDocumentId: proof.documentId },
  });
  check(claim1.status === 'awaiting_confirmation', 'a transfer waits for the shop to see the money');
  const waiting = await call('GET', `/orgs/${orgId}/incoming-payments?status=awaiting_confirmation`, { token: owner });
  say(`owner is told: ${waiting[0].payer_name} says ${rs(waiting[0].amount_cents)} by ${waiting[0].provider}, ref ${waiting[0].reference}, screenshot ${waiting[0].proofUrl ? 'attached' : 'missing'}`);
  const conf1 = await call('POST', `/orgs/${orgId}/incoming-payments/${claim1.paymentId}/confirm`, { token: owner, body: { receivedOn: '2026-09-30', bankReference: 'MCB JUICE IN 30/09' } });
  check(conf1.requestStatus === 'paid', 'confirming should settle the pay link');
  say('confirmed: receipt posted against INV-00001; the link now shows paid');

  step('A bank transfer the customer says they made, but nothing arrived: the shop rejects it');
  const req3 = await call('POST', `/orgs/${orgId}/payment-requests`, { token: owner, body: { payableKind: 'invoice', payableId: inv.transactionId, amountCents: 50_000 } });
  const t3 = tokenOf(req3.payUrl);
  const claim3 = await call('POST', `/pay/${t3}/notify`, { body: { method: 'bank_transfer', paidOn: '2026-09-30', payerName: 'Hotel Demo Ltd' } });
  await call('POST', `/pay/${t3}/notify`, { body: { method: 'bank_transfer', paidOn: '2026-09-30' }, expect: [409] });
  await call('POST', `/orgs/${orgId}/incoming-payments/${claim3.paymentId}/reject`, { token: owner, body: { reason: 'Nothing arrived in the MCB account' } });
  const view3 = await call('GET', `/pay/${t3}`);
  check(view3.status === 'open' && !view3.pendingConfirmation, 'a rejected claim leaves the link open for a real payment');
  say('second claim on the same link refused while the first was pending; rejected; link still open');

  step('Customer pays Rs 1,000 by card through MIPS; the encrypted IMN confirms it');
  const req2 = await call('POST', `/orgs/${orgId}/payment-requests`, { token: owner, body: { payableKind: 'invoice', payableId: inv.transactionId, amountCents: 100_000 } });
  const t2 = tokenOf(req2.payUrl);
  const zone = await call('POST', `/pay/${t2}/card`);
  check(zone.kind === 'html', 'MIPS answers with a payment zone to show on the pay page');
  say(`payment zone received (${zone.html.length} characters of HTML to embed)`);
  await call('POST', '/webhooks/mips', { body: { crypted_callback: 'forged-notification' }, expect: [400] });
  say('an IMN that does not decrypt is rejected (400)');
  const imn = MockMipsClient.encrypt(mockImn(`${req2.reference}-01`, 100_000));
  const m1 = await call('POST', '/webhooks/mips', { body: { crypted_callback: imn } });
  const m2 = await call('POST', '/webhooks/mips', { body: { crypted_callback: imn } });
  check(m2.duplicate === true, 'a repeated IMN must not post twice');
  check((await call('GET', `/pay/${t2}`)).status === 'paid', 'the MIPS-paid link shows paid');
  say(`IMN ${JSON.stringify(m1)}, repeat ${JSON.stringify(m2)}`);

  step('Owner books the Nex-Gen onboarding call: Rs 25 deposit by card through Stripe');
  const bk = await call('POST', `/orgs/${orgId}/bookings`, { token: owner, body: { startsAt: '2026-10-08T10:00:00+04:00' } });
  check(bk.amountCents === 2500, 'default deposit should be Rs 25.00');
  const tb = tokenOf(bk.payUrl);
  const bview = await call('GET', `/pay/${tb}`);
  say(`pay ${bview.payeeName} ${rs(bview.amountCents)}, reference ${bview.reference}; ways to pay: ${bview.methods.map((m: any) => m.kind).join(', ')}`);
  const sc = await call('POST', `/pay/${tb}/card`);
  check(sc.kind === 'redirect', 'Stripe sends the payer to its hosted checkout');
  const stripePaymentId = /dev\/card\/([0-9a-f-]{36})/.exec(sc.url)?.[1] as string;
  const ev = await stripeEvent(`cs_mock_${stripePaymentId}`, stripePaymentId, creds.platformOrgId, 2500);
  await call('POST', '/webhooks/stripe', { body: ev.payload, headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=forged' }, expect: [400] });
  const w1 = await call('POST', '/webhooks/stripe', { body: ev.payload, headers: { 'content-type': 'application/json', 'stripe-signature': ev.header } });
  const w2 = await call('POST', '/webhooks/stripe', { body: ev.payload, headers: { 'content-type': 'application/json', 'stripe-signature': ev.header } });
  check(w2.duplicate === true, 'a retried Stripe webhook must not post twice');
  const bookings = await call('GET', `/orgs/${orgId}/bookings`, { token: owner });
  check(bookings[0].status === 'confirmed', 'paid booking should be confirmed');
  const platformPot = await call('GET', `/orgs/${creds.platformOrgId}/vat-pot`, { token: admin });
  say(`forged signature refused, first delivery ${JSON.stringify(w1)}, retry ${JSON.stringify(w2)}; booking confirmed; Nex-Gen output VAT ${rs(platformPot.outputVatCents)}`);
  check(platformPot.outputVatCents === 326, 'Rs 25.00 VAT-inclusive carries Rs 3.26 VAT');

  step('Owner pays the opening supplier balance; ageing for both sides');
  const contacts = await call('GET', `/orgs/${orgId}/contacts`, { token: owner });
  const supplier = contacts.find((c: any) => c.name === 'Grossiste Demo Ltd');
  const openingItems = await call('GET', `/orgs/${orgId}/transactions?kind=opening_balance`, { token: owner });
  const owed = openingItems.find((t: any) => t.contact_name === 'Grossiste Demo Ltd');
  await call('POST', `/orgs/${orgId}/payments`, {
    token: owner,
    body: { kind: 'payment', contactId: supplier.id, date: '2026-09-20', method: 'bank', amountCents: 345_000, allocations: [{ invoiceId: owed.id, amountCents: 345_000 }] },
  });
  const recv = await call('GET', `/orgs/${orgId}/ageing?side=receivable&asOf=2026-10-01`, { token: owner });
  const pay = await call('GET', `/orgs/${orgId}/ageing?side=payable&asOf=2026-10-01`, { token: owner });
  say(`customers owe ${rs(recv.total)} ${JSON.stringify(recv.buckets)}`);
  say(`we owe suppliers ${rs(pay.total)} ${JSON.stringify(pay.buckets)}`);
  check(recv.total === 120_000 + 460_000 - 200_000 - 100_000, 'receivables = opening 1,200 + invoice 4,600 - Juice 2,000 - MIPS 1,000');
  check(pay.total === 460_000, 'payables = INV-0457 only after paying the opening balance');

  step('VAT Pot for Q3, then the owner taps "I am done"');
  const periods = await call('GET', `/orgs/${orgId}/periods`, { token: owner });
  const q3 = periods.find((p: any) => p.starts_on === '2026-07-01');
  const pot = await call('GET', `/orgs/${orgId}/vat-pot?periodId=${q3.id}`, { token: owner });
  say(`output ${rs(pot.outputVatCents)} - input ${rs(pot.inputVatCents)} = set aside ${rs(pot.setAsideCents)}; ${rs(pot.outputVatOnUnpaidSalesCents)} of it is on sales not yet paid`);
  check(pot.outputVatCents === 150_000 && pot.inputVatCents === 99_000 && pot.setAsideCents === 51_000, 'VAT Pot figures');
  await call('POST', `/orgs/${orgId}/periods/${q3.id}/ready`, { token: owner });

  step('Reviewer: portfolio and queue, a question to the owner, the answer, approval');
  const reviewer = await staffLogin(staff('reviewer').email, staff('reviewer').password, staff('reviewer').totpSecret);
  const portfolio = await call('GET', '/reviewer/portfolio', { token: reviewer });
  say(`portfolio: ${portfolio.map((p: any) => `${p.orgName} ${p.periodLabel} ${p.periodStatus} risk ${p.riskScore}`).join('; ')}`);
  const queue = await call('GET', '/reviewer/queue', { token: reviewer });
  check(queue.some((q: any) => q.document_id === d3.id), 'handwritten receipt should be in the review queue');
  const q = await call('POST', `/orgs/${orgId}/queries`, { token: reviewer, body: { documentId: d3.id, body: 'Ti Kanal Hardware has no VAT number on this receipt, so its VAT cannot be claimed. Was this paint for the shop?' } });
  await call('POST', `/orgs/${orgId}/queries/${q.queryId}/messages`, { token: owner, body: { body: 'Wi, pou repint laboutik.' } });
  const approved = await call('POST', `/orgs/${orgId}/documents/${d3.id}/approve`, { token: reviewer, body: { corrections: { supplierName: 'Ti Kanal Hardware' } } });
  await call('POST', `/orgs/${orgId}/queries/${q.queryId}/resolve`, { token: reviewer });
  say(`approved and posted (entry #${approved.posting?.entryNo}); question resolved`);

  step('Return: reviewer drafts, only a senior reviewer can sign off');
  const draft = await call('POST', `/orgs/${orgId}/periods/${q3.id}/returns`, { token: reviewer });
  say(`draft v${draft.version}: output ${rs(draft.figures.outputVat.total)}, input ${rs(draft.figures.inputVat.total)}, payable ${rs(draft.figures.netPayable)}`);
  check(draft.figures.netPayable === 51_000, 'return should show Rs 510.00 payable');
  await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/sign-off`, { token: reviewer, expect: [403] });
  say('reviewer sign-off refused (403)');
  const senior = await staffLogin(staff('senior_reviewer').email, staff('senior_reviewer').password, staff('senior_reviewer').totpSecret);
  const signed = await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/sign-off`, { token: senior });
  say(`signed off; fingerprint ${signed.fingerprint.slice(0, 16)}...; Q3 is now locked`);

  step('A late purchase invoice dated 25/09 arrives after sign-off');
  const late = await upload(owner, orgId, 'demo-late-grossiste-INV-0502.jpg', await page('GROSSISTE DEMO LTD - VAT INVOICE', ['VAT No 27999902', 'Invoice INV-0502   25/09/2026', 'Bill to: Boutik Demo Ltd', 'Net Rs 2,000.00', 'VAT Rs 300.00']));
  const la = await call('POST', `/orgs/${orgId}/documents/${late.id}/answers`, { token: owner, body: { settlement: { mode: 'credit' }, category: cat(/stock|resale/) } });
  const lateDoc = await call('GET', `/orgs/${orgId}/documents/${late.id}`, { token: owner });
  say(`${la.outcome}; recorded late: ${lateDoc.transaction?.is_late} (${lateDoc.transaction?.late_reason ?? ''})`);
  check(lateDoc.transaction?.is_late === true, 'a document for a locked period goes into the next open period, flagged late');
  const lateSale = await call('POST', `/orgs/${orgId}/sales-invoices`, {
    token: owner, body: { customerName: 'Hotel Demo Ltd', issueDate: '2026-09-28', settlement: { mode: 'credit' }, lines: [{ description: 'Late-billed delivery', netCents: 50_000, vatCode: 'SR' }] },
  });
  say(`late sales invoice ${lateSale.reference}: posted into the next period, late=${lateSale.posting?.late}; a blocking question was raised automatically`);

  step('Filing: guide, filing pack PDF, MRA acknowledgement, payment, close');
  const guide = await call('GET', `/orgs/${orgId}/returns/${draft.returnId}/guide`, { token: owner });
  for (const g of guide.steps.filter((s: any) => s.amountCents !== undefined)) say(`${g.title}: ${rs(g.amountCents)}`);
  const pdf = await call('GET', `/orgs/${orgId}/returns/${draft.returnId}/filing-pack.pdf`, { token: owner, raw: true });
  await writeFile(join(OUT, 'filing-pack-Q3-2026.pdf'), pdf);
  say(`filing pack saved: demo-output/filing-pack-Q3-2026.pdf (${Math.round(pdf.length / 1024)} KB)`);
  const ack = await upload(owner, orgId, 'mra-acknowledgement.jpg', await page('MRA e-Services', ['VAT return received', 'Acknowledgement VATACK-DEMO-0001']), 'mra_acknowledgement');
  await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/acknowledgement`, { token: owner, body: { mraReference: 'VATACK-DEMO-0001', documentId: ack.id } });
  await call('POST', `/orgs/${orgId}/returns/${draft.returnId}/payment`, { token: owner, body: { paymentReference: 'MCB-DEMO-7781', paidOn: '2026-10-19' } });
  await call('POST', `/orgs/${orgId}/periods/${q3.id}/close`, { token: reviewer });
  const after = await call('GET', `/orgs/${orgId}/periods`, { token: owner });
  say(after.map((p: any) => `${p.starts_on}: ${p.status}`).join(' | '));

  step('Reminders the day before (Kreol for this owner) and tenant isolation');
  const r1 = await call('POST', '/admin/reminders/run', { token: admin, body: { now: '2026-10-07T06:00:00Z' } });
  say(`eve of the booking: ${JSON.stringify(r1)}`);
  const r2 = await call('POST', '/admin/reminders/run', { token: admin, body: { now: '2027-01-19T06:00:00Z' } });
  say(`eve of the Q4 deadline: ${JSON.stringify(r2)}`);
  const again = await call('POST', '/admin/reminders/run', { token: admin, body: { now: '2027-01-19T06:30:00Z' } });
  check(again.queued === 0, 'a reminder is never queued twice');
  await call('POST', '/auth/otp/start', { body: { phone: OTHER_PHONE } });
  const other = (await call('POST', '/auth/otp/verify', { body: { phone: OTHER_PHONE, code: OTP } })).accessToken as string;
  await call('POST', '/orgs', { token: other, body: { legalName: 'Other Shop Ltd', legalForm: 'company', startDate: '2026-07-01' } });
  await call('GET', `/orgs/${orgId}/vat-pot`, { token: other, expect: [403, 404] });
  say('another shop owner cannot read Boutik Demo (refused)');

  step('Audit trail: hash chain verifies end to end');
  const audit = await call('GET', `/orgs/${orgId}/audit/verify`, { token: reviewer });
  say(JSON.stringify(audit));
  check(audit.ok === true, 'audit chain must verify');

  console.log('\nDemo finished: every check passed.');
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
