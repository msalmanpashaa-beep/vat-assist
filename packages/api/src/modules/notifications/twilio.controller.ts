import { Controller, Header, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import twilio from 'twilio';
import { AppConfig } from '../../config';
import { Public } from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { Db } from '../../db/db.service';

const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'ARRET', 'ARRÊT', 'ARETE'];
const START_WORDS = ['START', 'UNSTOP'];

@Controller('webhooks/twilio')
export class TwilioWebhooksController {
  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
  ) {}

  /** Twilio signs every callback with the auth token; reject anything that does not verify. */
  private verify(req: Request, signature: string | undefined): void {
    const token = this.cfg.env.TWILIO_AUTH_TOKEN;
    if (!token) {
      if (this.cfg.isProduction) throw new DomainError('not_configured', 'Twilio is not configured.', 503);
      return;
    }
    const url = `${this.cfg.env.PUBLIC_BASE_URL}${req.originalUrl}`;
    if (!twilio.validateRequest(token, signature ?? '', url, req.body as Record<string, string>)) {
      throw new DomainError('bad_signature', 'Twilio signature check failed.', 403);
    }
  }

  @Public()
  @Post('status')
  @HttpCode(204)
  async status(@Req() req: Request, @Headers('x-twilio-signature') signature?: string): Promise<void> {
    this.verify(req, signature);
    const sid = String(req.body?.MessageSid ?? '');
    const raw = String(req.body?.MessageStatus ?? '');
    const status = raw === 'delivered' || raw === 'read' ? 'delivered' : raw === 'failed' || raw === 'undelivered' ? 'failed' : null;
    if (!sid || !status) return;
    const r = await this.db.run({ kind: 'system', orgId: null }, (tx) => tx.one<{ org: string | null }>(`select app.outbound_message_org($1) as org`, [sid]));
    if (!r.org) return;
    await this.db.run({ kind: 'system', orgId: r.org }, (tx) =>
      tx.exec(`update outbound_messages set status = $2, error = $3 where provider_sid = $1`, [sid, status, req.body?.ErrorCode ? `Twilio error ${req.body.ErrorCode}` : null]),
    );
  }

  /** Replies of STOP / ARRET opt the number out of SMS reminders; START opts back in. */
  @Public()
  @Post('inbound')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async inbound(@Req() req: Request, @Headers('x-twilio-signature') signature?: string): Promise<string> {
    this.verify(req, signature);
    const from = String(req.body?.From ?? '').replace(/^whatsapp:/, '');
    const word = String(req.body?.Body ?? '').trim().toUpperCase();
    if (from && (STOP_WORDS.includes(word) || START_WORDS.includes(word))) {
      await this.db.run({ kind: 'auth' }, (tx) =>
        tx.exec(`update users set sms_opt_out_at = ${STOP_WORDS.includes(word) ? 'now()' : 'null'} where phone_e164 = $1`, [from]),
      );
    }
    return '<Response></Response>';
  }
}
