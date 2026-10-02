import { createServer } from 'node:http';
import { type ParsedMail, simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig, type Env } from '../src/config';
import { ConsoleMail, createMailProvider, formatAddress, M365Mail, MailError, PostmarkMail, ResendMail, SmtpMail, smtpTransportOptions } from '../src/modules/mail/mail';
import { staffInviteEmail } from '../src/modules/mail/templates';

const message = {
  to: 'new.reviewer@nexgen.test', toName: 'New Reviewer', subject: 'Your VAT Assist invitation (Nex-Gen Africa)',
  html: '<p>Hello</p>', text: 'Hello', tag: 'staff_invite', idempotencyKey: 'staff-invite-abc123',
};
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

/** A fetch double: answers in order and records every request. */
function fakeFetch(...replies: Response[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra request');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
const json = (s: string) => JSON.parse(s) as Record<string, any>;
/** The MailError a send rejects with (fails the test if the send succeeds). */
async function failure(p: Promise<unknown>): Promise<MailError> {
  try {
    await p;
  } catch (e) {
    return e as MailError;
  }
  throw new Error('expected the send to fail');
}

describe('Postmark', () => {
  const opts = { token: 'server-token', from: 'Nex-Gen Africa <invites@nexgen.example>', replyTo: 'help@nexgen.example', stream: 'outbound', apiUrl: 'https://api.postmarkapp.com' };

  it('sends one email with the server token, both bodies, the stream and a tag', async () => {
    const f = fakeFetch(reply(200, { To: message.to, SubmittedAt: '2026-10-02T08:00:00Z', MessageID: 'pm-123', ErrorCode: 0, Message: 'OK' }));
    const sent = await new PostmarkMail(opts, f.impl).send(message);
    expect(sent).toEqual({ provider: 'postmark', id: 'pm-123' });
    expect(f.calls[0]!.url).toBe('https://api.postmarkapp.com/email');
    expect(f.calls[0]!.headers['X-Postmark-Server-Token']).toBe('server-token');
    expect(json(f.calls[0]!.body)).toEqual({
      From: opts.from, To: '"New Reviewer" <new.reviewer@nexgen.test>', Subject: message.subject, HtmlBody: '<p>Hello</p>', TextBody: 'Hello',
      MessageStream: 'outbound', Tag: 'staff_invite', ReplyTo: 'help@nexgen.example',
    });
  });

  it('a rejected message (422 with an ErrorCode) is a permanent failure', async () => {
    const f = fakeFetch(reply(422, { ErrorCode: 400, Message: 'Sender signature not defined' }));
    const err = await failure(new PostmarkMail(opts, f.impl).send(message));
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ provider: 'postmark', retryable: false, status: 422 });
    expect(err.message).toContain('Sender signature not defined (ErrorCode 400)');
  });

  it('an outage or a network failure is retryable', async () => {
    const down = await failure(new PostmarkMail(opts, fakeFetch(reply(503, 'unavailable')).impl).send(message));
    expect(down).toMatchObject({ retryable: true, status: 503 });
    const offline = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const net = await failure(new PostmarkMail(opts, offline).send(message));
    expect(net).toMatchObject({ provider: 'postmark', retryable: true });
  });
});

describe('Resend', () => {
  const opts = { apiKey: 're_test_key', from: 'Nex-Gen Africa <invites@nexgen.example>', apiUrl: 'https://api.resend.com' };

  it('sends with a bearer key and an idempotency key, returning the message id', async () => {
    const f = fakeFetch(reply(200, { id: 'rs-49a3' }));
    const sent = await new ResendMail(opts, f.impl).send(message);
    expect(sent).toEqual({ provider: 'resend', id: 'rs-49a3' });
    expect(f.calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer re_test_key');
    expect(f.calls[0]!.headers['Idempotency-Key']).toBe('staff-invite-abc123');
    expect(json(f.calls[0]!.body)).toEqual({
      from: opts.from, to: ['"New Reviewer" <new.reviewer@nexgen.test>'], subject: message.subject, html: '<p>Hello</p>', text: 'Hello',
      tags: [{ name: 'kind', value: 'staff_invite' }],
    });
  });

  it('rate limiting is retryable; a validation error is not', async () => {
    const limited = await failure(new ResendMail(opts, fakeFetch(reply(429, { message: 'Too many requests' })).impl).send(message));
    expect(limited).toMatchObject({ retryable: true, status: 429 });
    const invalid = await failure(new ResendMail(opts, fakeFetch(reply(422, { message: 'The domain is not verified' })).impl).send(message));
    expect(invalid).toMatchObject({ retryable: false, status: 422 });
    expect(invalid.message).toBe('resend: The domain is not verified');
  });
});

describe('Microsoft 365 (Graph)', () => {
  const opts = {
    tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1', sender: 'invites@nexgen.example',
    loginUrl: 'https://login.microsoftonline.com', graphUrl: 'https://graph.microsoft.com',
  };
  const token = (value: string, expiresIn = 3600) => reply(200, { token_type: 'Bearer', expires_in: expiresIn, access_token: value });
  const accepted = (requestId: string) => reply(202, null, { 'request-id': requestId });

  it('gets an app-only token, then sends as the configured mailbox', async () => {
    const f = fakeFetch(token('tok-1'), accepted('req-1'));
    const sent = await new M365Mail(opts, f.impl).send(message);
    expect(sent).toEqual({ provider: 'm365', id: 'req-1' });
    expect(f.calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    const form = new URLSearchParams(f.calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'client-1', client_secret: 'secret-1', scope: 'https://graph.microsoft.com/.default' });
    expect(f.calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/users/invites%40nexgen.example/sendMail');
    expect(f.calls[1]!.headers.Authorization).toBe('Bearer tok-1');
    expect(json(f.calls[1]!.body)).toEqual({
      message: { subject: message.subject, body: { contentType: 'HTML', content: '<p>Hello</p>' }, toRecipients: [{ emailAddress: { address: message.to, name: 'New Reviewer' } }] },
      saveToSentItems: true,
    });
  });

  it('reuses the token until it is about to expire', async () => {
    let now = 1_000_000;
    const f = fakeFetch(token('tok-1', 3600), accepted('a'), accepted('b'), token('tok-2', 3600), accepted('c'));
    const m = new M365Mail(opts, f.impl, () => now);
    await m.send(message);
    await m.send(message);
    now += 3_600_000; // an hour later the first token has expired
    await m.send(message);
    expect(f.calls.map((c) => c.url.includes('/oauth2/') ? 'token' : 'send')).toEqual(['token', 'send', 'send', 'token', 'send']);
    expect(f.calls[4]!.headers.Authorization).toBe('Bearer tok-2');
  });

  it('a revoked token (401) is replaced once and the send retried', async () => {
    const f = fakeFetch(token('old'), reply(401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } }), token('new'), accepted('req-2'));
    const sent = await new M365Mail(opts, f.impl).send(message);
    expect(sent.id).toBe('req-2');
    expect(f.calls[3]!.headers.Authorization).toBe('Bearer new');
  });

  it('403 explains the mailbox permission and is not retried', async () => {
    const f = fakeFetch(token('tok'), reply(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied' } }));
    const err = await failure(new M365Mail(opts, f.impl).send(message));
    expect(err).toMatchObject({ provider: 'm365', retryable: false, status: 403 });
    expect(err.message).toContain('Application Mail.Send');
  });

  it('a bad client secret fails at the token step with Microsoft\'s reason', async () => {
    const f = fakeFetch(reply(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
    const err = await failure(new M365Mail(opts, f.impl).send(message));
    expect(err.message).toContain('AADSTS7000215');
    expect(f.calls).toHaveLength(1);
  });
});

describe('choosing the provider', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', JWT_SECRET: 'x'.repeat(48), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const cfg = (extra: Record<string, string>) => AppConfig.fromEnv({ ...base, ...extra } as NodeJS.ProcessEnv);

  it('defaults to the console provider in development', () => {
    expect(createMailProvider(cfg({}))).toBeInstanceOf(ConsoleMail);
  });

  it('refuses to start a real provider without its settings, naming what is missing', () => {
    expect(() => createMailProvider(cfg({ MAIL_PROVIDER: 'postmark' }))).toThrow('POSTMARK_SERVER_TOKEN');
    expect(() => createMailProvider(cfg({ MAIL_PROVIDER: 'm365', M365_TENANT_ID: 't' }))).toThrow('M365_CLIENT_ID, M365_CLIENT_SECRET, M365_SENDER');
    expect(createMailProvider(cfg({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' }))).toBeInstanceOf(ResendMail);
  });

  it('production refuses the console provider and placeholder senders', () => {
    const prod: Partial<Env> = { NODE_ENV: 'production', MAIL_PROVIDER: 'postmark', MAIL_FROM: 'VAT Assist <invites@example.com>' };
    const problems = AppConfig.productionProblems({ ...cfg({}).env, ...prod });
    expect(problems).toContain('MAIL_FROM must be a real, verified sender address');
    expect(AppConfig.productionProblems({ ...cfg({}).env, NODE_ENV: 'production' })).toContain('MAIL_PROVIDER must be smtp, postmark, resend or m365');
  });
});

describe('console provider and the invite email', () => {
  it('keeps the newest 50 messages for the development outbox', async () => {
    const c = new ConsoleMail();
    for (let i = 0; i < 55; i++) await c.send({ ...message, subject: `n${i}` });
    expect(c.outbox).toHaveLength(50);
    expect(c.outbox[0]!.subject).toBe('n54');
  });

  it('the invite carries the one-time link in both bodies, escapes names, and states the expiry in Mauritius time', () => {
    const e = staffInviteEmail({
      fullName: 'Jean <script>alert(1)</script>', roleLabel: 'a reviewer', inviteUrl: 'https://app.nexgen.example/invite/tok_123',
      expiresAt: new Date('2026-10-09T08:00:00Z'), invitedBy: 'Demo Admin', clients: 2,
    });
    expect(e.html).toContain('href="https://app.nexgen.example/invite/tok_123"');
    expect(e.text).toContain('https://app.nexgen.example/invite/tok_123');
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('Jean &lt;script&gt;');
    expect(e.text).toMatch(/9 October 2026.*12:00/);
    expect(e.text).toContain('You will start with 2 clients.');
  });

  it('addresses never carry header-breaking characters from a name', () => {
    expect(formatAddress('a@b.mu', 'Line\r\nBcc: x@y.z "quoted"')).toBe('"LineBcc: x@y.z quoted" <a@b.mu>');
    expect(formatAddress('a@b.mu')).toBe('a@b.mu');
  });
});

describe('over real HTTP', () => {
  it('Postmark request and response survive a real round trip (stand-in server)', async () => {
    const seen: Array<{ path: string; token: string | undefined; body: Record<string, any> }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', token: req.headers['x-postmark-server-token'] as string | undefined, body: JSON.parse(raw) });
        const bad = seen.length > 1;
        res.writeHead(bad ? 422 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(bad ? { ErrorCode: 406, Message: 'Inactive recipient' } : { ErrorCode: 0, Message: 'OK', MessageID: 'pm-real-1' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const pm = new PostmarkMail({ token: 'tok', from: 'VAT Assist <invites@nexgen.example>', stream: 'outbound', apiUrl: `http://127.0.0.1:${port}` });
      expect(await pm.send(message)).toEqual({ provider: 'postmark', id: 'pm-real-1' });
      expect(seen[0]).toMatchObject({ path: '/email', token: 'tok', body: { To: '"New Reviewer" <new.reviewer@nexgen.test>', MessageStream: 'outbound' } });
      await expect(pm.send(message)).rejects.toMatchObject({ retryable: false, status: 422, message: 'postmark: Inactive recipient (ErrorCode 406)' });
    } finally {
      server.close();
    }
  });

  it('the development provider fails on purpose for .invalid addresses', async () => {
    await expect(new ConsoleMail().send({ ...message, to: 'someone@fail.invalid' })).rejects.toMatchObject({ provider: 'console', retryable: false });
  });
});

/** An in-process SMTP server that checks the sign-in and keeps what it receives, like a cPanel mail server would. */
async function smtpSink(o: { user: string; pass: string; dataCode?: number; rcptCode?: number }) {
  const inbox: ParsedMail[] = [];
  const logins: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, cb) {
      logins.push(`${auth.username}:${auth.password}`);
      if (auth.username === o.user && auth.password === o.pass) return cb(null, { user: auth.username });
      return cb(Object.assign(new Error('Authentication failed'), { responseCode: 535 }));
    },
    onRcptTo(_address, _session, cb) {
      if (o.rcptCode) return cb(Object.assign(new Error('No such user here'), { responseCode: o.rcptCode }));
      return cb();
    },
    onData(stream, _session, cb) {
      if (o.dataCode) {
        stream.on('end', () => cb(Object.assign(new Error('Mailbox busy, try again later'), { responseCode: o.dataCode })));
        stream.resume();
        return;
      }
      simpleParser(stream).then((m) => { inbox.push(m); cb(); }, (e: Error) => cb(e));
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.server.address() as AddressInfo).port;
  return { inbox, logins, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('SMTP (a hosted mailbox, e.g. cPanel)', () => {
  const box = { host: '127.0.0.1', tls: 'none' as const, user: 'invites@nex-gen.africa', pass: 'mailbox-pass', from: 'Nex-Gen Africa <invites@nex-gen.africa>', replyTo: 'connect@nex-gen.africa' };
  const link = 'https://app.nex-gen.africa/invite/tok_1234567890';
  const env = (extra: Record<string, string>) =>
    AppConfig.fromEnv({ DATABASE_URL: 'postgres://localhost/x', JWT_SECRET: 'x'.repeat(48), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), ...extra } as NodeJS.ProcessEnv);

  it('signs in, then delivers text and HTML with the reply-to and kind header, over a real SMTP session', async () => {
    const sink = await smtpSink({ user: box.user, pass: box.pass });
    try {
      const sent = await new SmtpMail({ ...box, port: sink.port }).send({ ...message, text: `Hello ${link}`, html: `<p>Hello <a href="${link}">set up</a></p>` });
      expect(sent.provider).toBe('smtp');
      expect(sent.id).toMatch(/@/);
      expect(sink.logins).toEqual([`${box.user}:${box.pass}`]);
      const got = sink.inbox[0]!;
      expect(got.from?.text).toContain('invites@nex-gen.africa');
      const to = Array.isArray(got.to) ? got.to[0] : got.to;
      expect(to?.text).toContain('New Reviewer');
      expect(to?.text).toContain('new.reviewer@nexgen.test');
      expect(got.replyTo?.text).toContain('connect@nex-gen.africa');
      expect(got.subject).toBe(message.subject);
      expect(got.text).toContain(link);
      expect(got.html).toContain(`href="${link}"`);
      expect(got.headers.get('x-vat-assist-kind')).toBe('staff_invite');
    } finally {
      await sink.close();
    }
  });

  it('a wrong mailbox password is permanent, and the message says how to fix it', async () => {
    const sink = await smtpSink({ user: box.user, pass: 'the-real-one' });
    try {
      const err = await failure(new SmtpMail({ ...box, port: sink.port }).send(message));
      expect(err).toMatchObject({ provider: 'smtp', retryable: false });
      expect(err.message).toContain('full address as SMTP_USER');
      expect(sink.inbox).toHaveLength(0);
    } finally {
      await sink.close();
    }
  });

  it('a temporary refusal (451) is retryable; an unknown recipient (550) is not', async () => {
    const busy = await smtpSink({ user: box.user, pass: box.pass, dataCode: 451 });
    const unknown = await smtpSink({ user: box.user, pass: box.pass, rcptCode: 550 });
    try {
      expect(await failure(new SmtpMail({ ...box, port: busy.port }).send(message))).toMatchObject({ retryable: true, status: 451 });
      expect(await failure(new SmtpMail({ ...box, port: unknown.port }).send(message))).toMatchObject({ retryable: false, status: 550 });
    } finally {
      await busy.close();
      await unknown.close();
    }
  });

  it('a mail server that cannot be reached is retryable', async () => {
    const err = await failure(new SmtpMail({ ...box, port: 1 }).send(message));
    expect(err).toMatchObject({ provider: 'smtp', retryable: true });
    expect(err.message).toContain('could not reach the mail server');
  });

  it('TLS: 465 is TLS from the start, 587 must upgrade, plaintext only for a local test server', () => {
    expect(smtpTransportOptions({ ...box, port: 465, tls: 'implicit' })).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
    expect(smtpTransportOptions({ ...box, port: 587, tls: 'starttls' })).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
    const cpanel = { MAIL_PROVIDER: 'smtp', SMTP_HOST: 'mail.nex-gen.africa', SMTP_USER: box.user, SMTP_PASS: 'x', MAIL_FROM: box.from };
    expect(createMailProvider(env(cpanel))).toBeInstanceOf(SmtpMail);
    expect(() => createMailProvider(env({ ...cpanel, SMTP_TLS: 'none' }))).toThrow('only allowed for a local test server');
    expect(() => createMailProvider(env({ MAIL_PROVIDER: 'smtp' }))).toThrow('SMTP_HOST, SMTP_USER, SMTP_PASS');
    expect(AppConfig.productionProblems({ ...env(cpanel).env, NODE_ENV: 'production', SMTP_TLS: 'none' })).toContain('SMTP_TLS=none is not allowed in production');
  });
});
