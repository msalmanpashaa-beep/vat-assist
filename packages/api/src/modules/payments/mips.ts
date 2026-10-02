import type { AppConfig } from '../../config';
import { DomainError } from '../../common/errors';

/**
 * MIPS (Mauritius) e-commerce API: load_payment_zone returns the HTML of a hosted payment iframe for one
 * order; after a SUCCESSFUL payment MIPS posts an encrypted IMN to our URL, which we decrypt by calling
 * decrypt_imn_data with our salt and cipher key. A forged IMN cannot be decrypted, so the decrypt call is
 * also the authenticity check.
 */
export interface MipsImnData {
  amount: string;
  currency: string;
  status: string;
  id_order: string;
  transaction_id?: string | null;
  payment_method?: string | null;
  reason_fail?: string | null;
}

export interface MipsClient {
  loadPaymentZone(o: { idOrder: string; amountCents: number; returnUrl: string; paymentId: string }): Promise<string>;
  decryptImn(crypted: string): Promise<MipsImnData>;
}

export const MIPS_CLIENT = Symbol('MIPS_CLIENT');

/** MIPS could not be reached: answer the IMN with 5xx so it can be delivered again. */
export class MipsUnavailableError extends Error {}

export class LiveMipsClient implements MipsClient {
  constructor(private readonly cfg: AppConfig) {}

  private creds() {
    const e = this.cfg.env;
    const c = {
      MIPS_ID_MERCHANT: e.MIPS_ID_MERCHANT, MIPS_ID_ENTITY: e.MIPS_ID_ENTITY, MIPS_ID_OPERATOR: e.MIPS_ID_OPERATOR,
      MIPS_OPERATOR_PASSWORD: e.MIPS_OPERATOR_PASSWORD, MIPS_SALT: e.MIPS_SALT, MIPS_CIPHER_KEY: e.MIPS_CIPHER_KEY,
      MIPS_BASIC_AUTH_USER: e.MIPS_BASIC_AUTH_USER, MIPS_BASIC_AUTH_PASS: e.MIPS_BASIC_AUTH_PASS,
    };
    const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new DomainError('mips_not_configured', `MIPS is not set up on this server (missing ${missing.join(', ')}).`, 503);
    return c as Record<keyof typeof c, string>;
  }

  private async post(path: 'load_payment_zone' | 'decrypt_imn_data', body: Record<string, unknown>): Promise<unknown> {
    const c = this.creds();
    let res: Response;
    try {
      res = await fetch(`${this.cfg.env.MIPS_API_URL}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${c.MIPS_BASIC_AUTH_USER}:${c.MIPS_BASIC_AUTH_PASS}`).toString('base64')}`,
        },
        body: JSON.stringify({
          authentify: { id_merchant: c.MIPS_ID_MERCHANT, id_entity: c.MIPS_ID_ENTITY, id_operator: c.MIPS_ID_OPERATOR, operator_password: c.MIPS_OPERATOR_PASSWORD },
          ...body,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new MipsUnavailableError(`MIPS ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 500) throw new MipsUnavailableError(`MIPS ${path} answered ${res.status}`);
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new DomainError('mips_rejected', `MIPS refused the ${path} request (${res.status}).`, 502);
    return data;
  }

  async loadPaymentZone(o: { idOrder: string; amountCents: number; returnUrl: string }): Promise<string> {
    const r = (await this.post('load_payment_zone', {
      order: { id_order: o.idOrder, currency: 'MUR', amount: Number((o.amountCents / 100).toFixed(2)) },
      iframe_behavior: { height: 560, width: 380, custom_redirection_url: o.returnUrl, language: 'EN' },
      request_mode: 'simple',
      touchpoint: this.cfg.env.MIPS_TOUCHPOINT,
    })) as { original_message?: string; answer?: { operation_status?: string; payment_zone_data?: string } } | null;
    const html = r?.answer?.operation_status === 'success' ? r.answer.payment_zone_data : undefined;
    if (!html) throw new DomainError('mips_rejected', `MIPS did not open a payment zone: ${r?.original_message ?? 'no reason given'}.`, 502);
    return html;
  }

  async decryptImn(crypted: string): Promise<MipsImnData> {
    const c = this.creds();
    const r = (await this.post('decrypt_imn_data', { salt: c.MIPS_SALT, cipher_key: c.MIPS_CIPHER_KEY, received_crypted_data: crypted })) as Record<string, unknown> | null;
    if (!r || typeof r.id_order !== 'string' || r.amount === undefined) {
      throw new DomainError('imn_invalid', 'MIPS could not decrypt this notification with our keys.', 400);
    }
    return { ...(r as unknown as MipsImnData), amount: String(r.amount), currency: String(r.currency ?? ''), status: String(r.status ?? '') };
  }
}

/** Development stand-in: the "encryption" is base64url JSON, so the demo can post realistic IMNs. */
export class MockMipsClient implements MipsClient {
  constructor(private readonly baseUrl: string) {}

  static encrypt(d: MipsImnData): string {
    return Buffer.from(JSON.stringify(d)).toString('base64url');
  }

  async loadPaymentZone(o: { idOrder: string; amountCents: number; paymentId: string }): Promise<string> {
    return (
      `<div class="mips-mock"><p>Test MIPS payment zone for order ${o.idOrder}: Rs ${(o.amountCents / 100).toFixed(2)}</p>` +
      `<form method="post" action="${this.baseUrl}/dev/card/${o.paymentId}/pay"><button type="submit">Pay (test card)</button></form></div>`
    );
  }

  async decryptImn(crypted: string): Promise<MipsImnData> {
    try {
      const d = JSON.parse(Buffer.from(crypted, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (typeof d.id_order !== 'string') throw new Error('no order');
      return { ...(d as unknown as MipsImnData), amount: String(d.amount), currency: String(d.currency ?? ''), status: String(d.status ?? '') };
    } catch {
      throw new DomainError('imn_invalid', 'Could not read this notification.', 400);
    }
  }
}

export function createMipsClient(cfg: AppConfig): MipsClient {
  return cfg.env.PAYMENTS_MODE === 'live' ? new LiveMipsClient(cfg) : new MockMipsClient(cfg.env.PUBLIC_BASE_URL);
}
