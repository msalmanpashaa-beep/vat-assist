/* eslint-disable @typescript-eslint/no-explicit-any */
import { call, ownerLogin, snap, staffCredentials, staffLogin, invoicePhoto } from './http';

/**
 * Test data for trying the owner and admin screens by hand (see docs/DEMO-SCREENS.md). Creates a shop with NO
 * opening balances (you enter them in onboarding), two customers, a supplier and one supplier bill on credit.
 * Run after `npm run db:seed` with the API running. Everything is fictional.
 */
const OWNER_PHONE = '+23057100031';

async function main(): Promise<void> {
  const creds = staffCredentials();
  const by = (role: string) => creds.staff.find((s) => s.role === role)!;
  const owner = await ownerLogin(OWNER_PHONE, 'en');
  const me = await call('GET', '/me', { token: owner });
  let orgId: string = me.memberships.find((m: any) => m.role === 'owner')?.orgId;
  if (!orgId) {
    orgId = (await call('POST', '/orgs', {
      token: owner,
      body: { legalName: 'Boutik Demo Ltd', tradingName: 'Boutik Screens', legalForm: 'company', vatNumber: '99999903', filingFrequency: 'quarterly', startDate: '2026-07-01', defaultLocale: 'en' },
    })).orgId;
  }
  const admin = await staffLogin(by('admin').email, by('admin').password, by('admin').totpSecret);
  await call('POST', `/admin/orgs/${orgId}/staff`, { token: admin, body: { userId: by('reviewer').userId, role: 'reviewer' } });
  await call('POST', `/admin/orgs/${orgId}/staff`, { token: admin, body: { userId: by('senior_reviewer').userId, role: 'senior_reviewer' } });
  await call('POST', `/orgs/${orgId}/contacts`, { token: owner, body: { name: 'Hotel Demo Ltd', kind: 'customer', phone: '+23057100021', reminderConsent: true, paymentTermsDays: 30 } });
  await call('POST', `/orgs/${orgId}/contacts`, { token: owner, body: { name: 'Restoran Demo', kind: 'customer' } });
  await call('POST', `/orgs/${orgId}/contacts`, { token: owner, body: { name: 'Grossiste Demo Ltd', kind: 'supplier' } });
  const docs = await call('GET', `/orgs/${orgId}/documents`, { token: owner });
  if (!docs.some((d: any) => d.original_filename === 'demo-grossiste-INV-0457.jpg')) {
    const d = await snap(owner, orgId, 'demo-grossiste-INV-0457.jpg', await invoicePhoto('GROSSISTE DEMO LTD INV-0457'));
    await call('POST', `/orgs/${orgId}/documents/${d.id}/answers`, { token: owner, body: { settlement: { mode: 'credit' }, category: 'stock_for_resale' } });
  }
  console.log(`Ready: "Boutik Screens" (${orgId})
  Owner: sign in with ${OWNER_PHONE}, code ${process.env.OTP_DEV_FIXED_CODE ?? '000000'} (web: /owner/login, phone app: sign-in screen)
  Admin: ${by('admin').email} / ${by('admin').password}, authenticator secret in demo-output/staff-credentials.json
  Customers: Hotel Demo Ltd (mobile +23057100021, agreed to reminders), Restoran Demo (no mobile)
  Supplier: Grossiste Demo Ltd, with bill INV-0457 for Rs 4,600 on credit
  Opening balances are NOT entered yet: do it from onboarding. Walkthrough: docs/DEMO-SCREENS.md`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
