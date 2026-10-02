/* eslint-disable @typescript-eslint/no-explicit-any */
import { generate } from 'otplib';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, ownerLogin, staffCredentials, staffLogin } from '../../src/scripts/http';

/**
 * Staff invite by email, end to end against the running API (MAIL_PROVIDER=console):
 * admin creates the invite → the email is sent → the invitee follows the emailed link, sets a password and an
 * authenticator → their memberships exist (the Nex-Gen role and the client they were linked to).
 */
const run = String(Date.now()).slice(-6);
const email = `invitee.${run}@nexgen.test`;
const creds = staffCredentials();
let admin = '';
let clientOrgId = '';
let inviteeId = '';
let emailedText = '';
let invitee = '';

beforeAll(async () => {
  await call('GET', '/health');
  const a = creds.staff.find((s) => s.role === 'admin')!;
  admin = await staffLogin(a.email, a.password, a.totpSecret);
  // A fresh client business to link the new reviewer to, so the suite can run repeatedly on one database.
  const owner = await ownerLogin(`+23057${run}`);
  clientOrgId = (await call('POST', '/orgs', { token: owner, body: { legalName: `Invite Client ${run} Ltd`, legalForm: 'company', startDate: '2026-07-01' } })).orgId;
});

describe('staff invite by email', () => {
  it('admin creates the invite: it is emailed, and the link is not shown in the console', async () => {
    const inv = await call('POST', '/admin/staff', { token: admin, body: { email, fullName: `Invitee ${run}`, role: 'reviewer', orgIds: [clientOrgId] } });
    inviteeId = inv.userId;
    expect(inv.email).toEqual({ status: 'sent', provider: 'console', error: null });
    expect(inv.inviteUrl).toBeNull();
    expect(inv.assignedClients).toBe(1);
  });

  it('the email went out with the one-time link, and the console records it', async () => {
    const outbox = await call('GET', `/dev/mail/outbox?to=${encodeURIComponent(email)}`);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].subject).toBe('Your VAT Assist invitation (Nex-Gen Africa)');
    expect(outbox[0].html).toContain('/invite/');
    expect(outbox[0].text).toContain('You will start with 1 client.');
    emailedText = outbox[0].text;
    const row = (await call('GET', '/admin/staff', { token: admin })).find((s: any) => s.user_id === inviteeId);
    expect(row).toMatchObject({ invite_pending: true, invite_email: { status: 'sent', provider: 'console', error: null } });
  });

  it('the invitee follows the emailed link: password, then authenticator; the link works once', async () => {
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(emailedText)?.[1];
    expect(token).toBeTruthy();
    const accepted = await call('POST', '/auth/staff/invite/accept', { body: { token, password: `Invitee-${run}-Pass!` } });
    expect(accepted.totpEnrolled).toBe(false);
    const auth = { authorization: `Bearer ${accepted.mfaToken}` };
    const setup = await call('POST', '/auth/staff/totp/setup', { headers: auth });
    const session = await call('POST', '/auth/staff/totp/verify', { body: { code: await generate({ secret: setup.secret }) }, headers: auth });
    invitee = session.accessToken;
    expect(invitee).toBeTruthy();
    await call('POST', '/auth/staff/invite/accept', { body: { token, password: 'Another-Pass-2026!' }, expect: [400] });
  });

  it('membership is created: Nex-Gen reviewer, plus the linked client in their portfolio', async () => {
    const me = await call('GET', '/me', { token: invitee });
    const roles = me.memberships.map((m: any) => `${m.orgId}:${m.role}`);
    expect(roles).toContain(`${creds.platformOrgId}:reviewer`);
    expect(roles).toContain(`${clientOrgId}:reviewer`);
    const portfolio = await call('GET', '/reviewer/portfolio', { token: invitee });
    expect(portfolio.map((p: any) => p.orgId)).toContain(clientOrgId);
    const row = (await call('GET', '/admin/staff', { token: admin })).find((s: any) => s.user_id === inviteeId);
    expect(row.invite_pending).toBe(false);
  });
});

describe('when the invite email cannot be sent', () => {
  const bounce = `bounce.${run}@fail.invalid`;
  let fallbackUrl = '';

  it('the invite still exists, the failure is recorded, and the admin gets the link to pass on', async () => {
    const inv = await call('POST', '/admin/staff', { token: admin, body: { email: bounce, fullName: `Bounce ${run}`, role: 'support' } });
    expect(inv.email).toMatchObject({ status: 'failed', provider: 'console' });
    expect(inv.email.error).toContain('simulated delivery failure');
    expect(inv.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
    fallbackUrl = inv.inviteUrl;
    const row = (await call('GET', '/admin/staff', { token: admin })).find((s: any) => s.user_id === inv.userId);
    expect(row.invite_email).toMatchObject({ status: 'failed', provider: 'console' });
    expect(await call('GET', `/dev/mail/outbox?to=${encodeURIComponent(bounce)}`)).toHaveLength(0);
  });

  it('the link handed over by the admin works the same way', async () => {
    const token = fallbackUrl.split('/invite/')[1];
    const accepted = await call('POST', '/auth/staff/invite/accept', { body: { token, password: `Bounce-${run}-Pass!` } });
    expect(accepted.mfaToken).toBeTruthy();
  });
});
