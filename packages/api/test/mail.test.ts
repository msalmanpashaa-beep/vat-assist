import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config';
import { ConsoleMail, createMailProvider, formatAddress, M365Mail, MailError, PostmarkMail, ResendMail } from '../src/modules/mail/mail';
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
    const err = await new PostmarkMail(opts, f.impl).send(message).catch((e: unknown) => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ provider: 'postmark', retryable: false, status: 422 });
    expect(err.message).toContain('Sender signature not defined (ErrorCode 400)');
  });

  it('an outage or a network failure is retryable', async () => {
    const down = await new PostmarkMail(opts, fakeFetch(reply(503, 'unavailable')).impl).send(message).catch((e: unknown) => e as MailError);
    expect(down).toMatchObject({ retryable: true, status: 503 });
    const offline = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const net = await new PostmarkMail(opts, offline).send(message).catch((e: unknown) => e as MailError);
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
    const limited = await new ResendMail(opts, fakeFetch(reply(429, { message: 'Too many requests' })).impl).send(message).catch((e: unknown) => e as MailError);
    expect(limited).toMatchObject({ retryable: true, status: 429 });
    const invalid = await new ResendMail(opts, fakeFetch(reply(422, { message: 'The domain is not verified' })).impl).send(message).catch((e: unknown) => e as MailError);
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
    const err = await new M365Mail(opts, f.impl).send(message).catch((e: unknown) => e as MailError);
    expect(err).toMatchObject({ provider: 'm365', retryable: false, status: 403 });
    expect(err.message).toContain('Application Mail.Send');
  });

  it('a bad client secret fails at the token step with Microsoft\'s reason', async () => {
    const f = fakeFetch(reply(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
    const err = await new M365Mail(opts, f.impl).send(message).catch((e: unknown) => e as MailError);
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
    const prod = { NODE_ENV: 'production', MAIL_PROVIDER: 'postmark', MAIL_FROM: 'VAT Assist <invites@example.com>' } as never;
    const problems = AppConfig.productionProblems({ ...cfg({}).env, ...prod });
    expect(problems).toContain('MAIL_FROM must be a real, verified sender address');
    expect(AppConfig.productionProblems({ ...cfg({}).env, NODE_ENV: 'production' })).toContain('MAIL_PROVIDER must be postmark, resend or m365');
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
