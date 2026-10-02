import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config';

export type MailProviderName = 'console' | 'postmark' | 'resend' | 'm365';

export interface OutboundEmail {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  /** Category shown in the provider's dashboard (Postmark Tag, Resend tag). */
  tag?: string;
  /** Stops a retried request from sending twice (Resend keeps keys for 24 hours). */
  idempotencyKey?: string;
}

export interface SentEmail {
  provider: MailProviderName;
  /** The provider's message id (Microsoft Graph returns none; its request-id is kept instead). */
  id: string | null;
}

/** The one interface the invite workflow uses; MAIL_PROVIDER picks the implementation. */
export interface MailProvider {
  readonly name: MailProviderName;
  send(message: OutboundEmail): Promise<SentEmail>;
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

/** A send that did not go through. `retryable`: worth another attempt later (network, rate limit, outage). */
export class MailError extends Error {
  constructor(message: string, readonly provider: MailProviderName, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = 'MailError';
  }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 10_000;
const isRetryable = (status: number) => status === 408 || status === 429 || status >= 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Reply { status: number; json: any; text: string; headers: Headers }

async function post(fetchImpl: Fetch, provider: MailProviderName, url: string, headers: Record<string, string>, body: string): Promise<Reply> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new MailError(`${provider}: could not reach the mail service (${e instanceof Error ? e.message : String(e)})`, provider, true);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** "Name" <address> for a To field; quotes, backslashes and line breaks are removed from the name. */
export function formatAddress(address: string, name?: string): string {
  const clean = name?.replace(/["\\\r\n]/g, '').trim();
  return clean ? `"${clean}" <${address}>` : address;
}

/**
 * Development: prints the email in the API log and keeps the last 50 in memory (GET /dev/mail/outbox).
 * Addresses on the reserved .invalid domain fail, so the "email could not be sent" path can be tried and tested.
 */
export class ConsoleMail implements MailProvider {
  readonly name = 'console' as const;
  private readonly log = new Logger('Mail');
  readonly outbox: Array<OutboundEmail & { id: string; sentAt: string }> = [];

  async send(m: OutboundEmail): Promise<SentEmail> {
    if (/\.invalid$/i.test(m.to)) throw new MailError('console: simulated delivery failure (.invalid address)', 'console', false);
    const id = `console-${randomUUID()}`;
    this.outbox.unshift({ ...m, id, sentAt: new Date().toISOString() });
    if (this.outbox.length > 50) this.outbox.length = 50;
    this.log.log(`Email to ${m.to}: ${m.subject}\n${m.text}`);
    return { provider: 'console', id };
  }
}

/** Postmark: POST /email with the server token; ErrorCode 0 means accepted. */
export class PostmarkMail implements MailProvider {
  readonly name = 'postmark' as const;
  constructor(
    private readonly o: { token: string; from: string; replyTo?: string; stream: string; apiUrl: string },
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async send(m: OutboundEmail): Promise<SentEmail> {
    const r = await post(
      this.fetchImpl,
      'postmark',
      `${this.o.apiUrl}/email`,
      { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': this.o.token },
      JSON.stringify({
        From: this.o.from,
        To: formatAddress(m.to, m.toName),
        Subject: m.subject,
        HtmlBody: m.html,
        TextBody: m.text,
        MessageStream: this.o.stream,
        ...(m.tag ? { Tag: m.tag } : {}),
        ...(this.o.replyTo ? { ReplyTo: this.o.replyTo } : {}),
      }),
    );
    const code = typeof r.json?.ErrorCode === 'number' ? (r.json.ErrorCode as number) : null;
    if (r.status >= 200 && r.status < 300 && (code === null || code === 0)) return { provider: 'postmark', id: r.json?.MessageID ?? null };
    const detail = r.json?.Message ?? r.text.slice(0, 200);
    throw new MailError(`postmark: ${detail}${code !== null ? ` (ErrorCode ${code})` : ''}`, 'postmark', isRetryable(r.status), r.status);
  }
}

/** Resend: POST /emails with a bearer key; an Idempotency-Key prevents duplicates on retry. */
export class ResendMail implements MailProvider {
  readonly name = 'resend' as const;
  constructor(
    private readonly o: { apiKey: string; from: string; replyTo?: string; apiUrl: string },
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async send(m: OutboundEmail): Promise<SentEmail> {
    const r = await post(
      this.fetchImpl,
      'resend',
      `${this.o.apiUrl}/emails`,
      {
        Authorization: `Bearer ${this.o.apiKey}`,
        'Content-Type': 'application/json',
        ...(m.idempotencyKey ? { 'Idempotency-Key': m.idempotencyKey } : {}),
      },
      JSON.stringify({
        from: this.o.from,
        to: [formatAddress(m.to, m.toName)],
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(this.o.replyTo ? { reply_to: this.o.replyTo } : {}),
        ...(m.tag ? { tags: [{ name: 'kind', value: m.tag }] } : {}),
      }),
    );
    if (r.status >= 200 && r.status < 300 && typeof r.json?.id === 'string') return { provider: 'resend', id: r.json.id };
    throw new MailError(`resend: ${r.json?.message ?? r.text.slice(0, 200)}`, 'resend', isRetryable(r.status), r.status);
  }
}

/**
 * Microsoft 365 through Microsoft Graph: an app-only token (client credentials), then POST
 * /users/{sender}/sendMail, which answers 202. Exchange RBAC for Applications limits the app to the sender mailbox.
 */
export class M365Mail implements MailProvider {
  readonly name = 'm365' as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly o: { tenantId: string; clientId: string; clientSecret: string; sender: string; replyTo?: string; loginUrl: string; graphUrl: string },
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(fresh: boolean): Promise<string> {
    if (!fresh && this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.o.clientId,
      client_secret: this.o.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    });
    const r = await post(this.fetchImpl, 'm365', `${this.o.loginUrl}/${encodeURIComponent(this.o.tenantId)}/oauth2/v2.0/token`,
      { 'Content-Type': 'application/x-www-form-urlencoded' }, form.toString());
    if (r.status !== 200 || typeof r.json?.access_token !== 'string') {
      throw new MailError(`m365: could not get a token (${r.json?.error_description ?? r.json?.error ?? `HTTP ${r.status}`})`, 'm365', isRetryable(r.status), r.status);
    }
    this.token = { value: r.json.access_token, expiresAt: this.now() + Number(r.json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async send(m: OutboundEmail): Promise<SentEmail> {
    const body = JSON.stringify({
      message: {
        subject: m.subject,
        body: { contentType: 'HTML', content: m.html },
        toRecipients: [{ emailAddress: { address: m.to, ...(m.toName ? { name: m.toName.replace(/[\r\n]/g, ' ') } : {}) } }],
        ...(this.o.replyTo ? { replyTo: [{ emailAddress: { address: this.o.replyTo } }] } : {}),
      },
      saveToSentItems: true,
    });
    const attempt = async (fresh: boolean) =>
      post(this.fetchImpl, 'm365', `${this.o.graphUrl}/v1.0/users/${encodeURIComponent(this.o.sender)}/sendMail`,
        { Authorization: `Bearer ${await this.accessToken(fresh)}`, 'Content-Type': 'application/json' }, body);
    let r = await attempt(false);
    if (r.status === 401) r = await attempt(true); // token revoked or rotated: one fresh token, one retry
    if (r.status === 202) return { provider: 'm365', id: r.headers.get('request-id') };
    const detail = r.json?.error?.message ?? (r.text.slice(0, 200) || `HTTP ${r.status}`);
    const hint = r.status === 403 ? ' Check the app holds the "Application Mail.Send" role for this mailbox (Exchange RBAC for Applications).' : '';
    throw new MailError(`m365: ${detail}.${hint}`, 'm365', isRetryable(r.status), r.status);
  }
}

/** Picks the provider from MAIL_PROVIDER and refuses to start if its settings are missing. */
export function createMailProvider(cfg: AppConfig, fetchImpl: Fetch = fetch): MailProvider {
  const e = cfg.env;
  const need = <T extends Record<string, string | undefined>>(vars: T): Record<keyof T, string> => {
    const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`MAIL_PROVIDER=${e.MAIL_PROVIDER} needs ${missing.join(', ')}`);
    return vars as Record<keyof T, string>;
  };
  switch (e.MAIL_PROVIDER) {
    case 'postmark': {
      const v = need({ POSTMARK_SERVER_TOKEN: e.POSTMARK_SERVER_TOKEN });
      return new PostmarkMail({ token: v.POSTMARK_SERVER_TOKEN, from: e.MAIL_FROM, replyTo: e.MAIL_REPLY_TO, stream: e.POSTMARK_MESSAGE_STREAM, apiUrl: e.POSTMARK_API_URL }, fetchImpl);
    }
    case 'resend': {
      const v = need({ RESEND_API_KEY: e.RESEND_API_KEY });
      return new ResendMail({ apiKey: v.RESEND_API_KEY, from: e.MAIL_FROM, replyTo: e.MAIL_REPLY_TO, apiUrl: e.RESEND_API_URL }, fetchImpl);
    }
    case 'm365': {
      const v = need({ M365_TENANT_ID: e.M365_TENANT_ID, M365_CLIENT_ID: e.M365_CLIENT_ID, M365_CLIENT_SECRET: e.M365_CLIENT_SECRET, M365_SENDER: e.M365_SENDER });
      return new M365Mail({
        tenantId: v.M365_TENANT_ID, clientId: v.M365_CLIENT_ID, clientSecret: v.M365_CLIENT_SECRET, sender: v.M365_SENDER,
        replyTo: e.MAIL_REPLY_TO, loginUrl: e.M365_LOGIN_URL, graphUrl: e.M365_GRAPH_URL,
      }, fetchImpl);
    }
    default:
      return new ConsoleMail();
  }
}
