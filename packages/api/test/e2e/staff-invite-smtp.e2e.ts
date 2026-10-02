/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ParsedMail, simpleParser } from 'mailparser';
import { generate } from 'otplib';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ownerLogin, staffCredentials, staffLogin } from '../../src/scripts/http';

/**
 * The invite flow over real SMTP, as with a cPanel mailbox: the API signs in to this test mail server and hands
 * over the message. Runs only when the API was started with MAIL_PROVIDER=smtp pointing here (npm run
 * test:e2e:smtp, see DEVELOPMENT.md); otherwise skipped.
 */
const port = Number(process.env.E2E_SMTP_SINK_PORT ?? 0);
const user = process.env.E2E_SMTP_USER ?? 'invites@nex-gen.africa';
const pass = process.env.E2E_SMTP_PASS ?? 'e2e-smtp-pass';
const replyTo = process.env.E2E_SMTP_REPLY_TO;
const suite = port ? describe : describe.skip;

suite('staff invite by email over SMTP (cPanel-style mailbox)', () => {
  const run = String(Date.now()).slice(-6);
  const email = `smtp.invitee.${run}@nexgen.test`;
  const inbox: ParsedMail[] = [];
  const logins: string[] = [];
  let server: SMTPServer;
  let admin = '';
  let clientOrgId = '';
  let inviteeId = '';
  let creds: ReturnType<typeof staffCredentials>;

  const arrival = async (to: string): Promise<ParsedMail> => {
    for (let i = 0; i < 50; i++) {
      const m = inbox.find((x) => (Array.isArray(x.to) ? x.to : [x.to]).some((a) => a?.text.includes(to)));
      if (m) return m;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no email arrived for ${to}`);
  };

  beforeAll(async () => {
    server = new SMTPServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      logger: false,
      onAuth(auth, _session, cb) {
        logins.push(auth.username ?? '');
        if (auth.username === user && auth.password === pass) return cb(null, { user: auth.username });
        return cb(Object.assign(new Error('Authentication failed'), { responseCode: 535 }));
      },
      onData(stream, _session, cb) {
        simpleParser(stream).then((m) => { inbox.push(m); cb(); }, (e: Error) => cb(e));
      },
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
    creds = staffCredentials();
    const a = creds.staff.find((s) => s.role === 'admin')!;
    admin = await staffLogin(a.email, a.password, a.totpSecret);
    const owner = await ownerLogin(`+23057${run}`);
    clientOrgId = (await call('POST', '/orgs', { token: owner, body: { legalName: `SMTP Client ${run} Ltd`, legalForm: 'company', startDate: '2026-07-01' } })).orgId;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('the admin test email arrives through the mailbox sign-in', async () => {
    const to = `smtp.check.${run}@nexgen.test`;
    expect(await call('POST', '/admin/mail/test', { token: admin, body: { to } })).toMatchObject({ status: 'sent', provider: 'smtp', error: null });
    expect((await arrival(to)).subject).toBe('VAT Assist test email');
    expect(logins).toContain(user);
  });

  it('admin invites → delivered over SMTP → the invitee accepts → memberships exist', async () => {
    const inv = await call('POST', '/admin/staff', { token: admin, body: { email, fullName: `SMTP Invitee ${run}`, role: 'reviewer', orgIds: [clientOrgId] } });
    expect(inv.email).toEqual({ status: 'sent', provider: 'smtp', error: null });
    expect(inv.inviteUrl).toBeNull();
    inviteeId = inv.userId;

    const m = await arrival(email);
    expect(m.from?.text).toContain(user);
    if (replyTo) expect(m.replyTo?.text).toContain(replyTo);
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(m.text ?? '')?.[1];
    expect(token).toBeTruthy();

    const accepted = await call('POST', '/auth/staff/invite/accept', { body: { token, password: `Smtp-${run}-Pass!` } });
    const auth = { authorization: `Bearer ${accepted.mfaToken}` };
    const setup = await call('POST', '/auth/staff/totp/setup', { headers: auth });
    const session = await call('POST', '/auth/staff/totp/verify', { body: { code: await generate({ secret: setup.secret }) }, headers: auth });
    const me = await call('GET', '/me', { token: session.accessToken });
    expect(me.memberships.map((x: any) => `${x.orgId}:${x.role}`)).toEqual(
      expect.arrayContaining([`${creds.platformOrgId}:reviewer`, `${clientOrgId}:reviewer`]),
    );
    const row = (await call('GET', '/admin/staff', { token: admin })).find((s: any) => s.user_id === inviteeId);
    expect(row).toMatchObject({ invite_pending: false, invite_email: { status: 'sent', provider: 'smtp' } });
  });
});
