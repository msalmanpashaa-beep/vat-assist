import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import twilio from 'twilio';
import type { AppConfig } from '../../config';

export interface MessagingProvider {
  readonly name: 'console' | 'twilio';
  sendSms(to: string, body: string): Promise<{ sid: string }>;
  sendWhatsApp(to: string, contentSid: string, variables: Record<string, string>): Promise<{ sid: string }>;
}

export const MESSAGING = Symbol('MESSAGING');

class ConsoleMessaging implements MessagingProvider {
  readonly name = 'console' as const;
  private readonly log = new Logger('Messages');
  async sendSms(to: string, body: string) {
    this.log.log(`SMS to ${to}: ${body}`);
    return { sid: `console-${randomUUID()}` };
  }
  async sendWhatsApp(to: string, contentSid: string, variables: Record<string, string>) {
    this.log.log(`WhatsApp to ${to}: template ${contentSid} ${JSON.stringify(variables)}`);
    return { sid: `console-${randomUUID()}` };
  }
}

class TwilioMessaging implements MessagingProvider {
  readonly name = 'twilio' as const;
  private readonly client: ReturnType<typeof twilio>;
  constructor(private readonly cfg: AppConfig) {
    if (!cfg.env.TWILIO_ACCOUNT_SID || !cfg.env.TWILIO_AUTH_TOKEN) throw new Error('MESSAGING_PROVIDER=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    this.client = twilio(cfg.env.TWILIO_ACCOUNT_SID, cfg.env.TWILIO_AUTH_TOKEN);
  }
  private get statusCallback() {
    return `${this.cfg.env.PUBLIC_BASE_URL}/webhooks/twilio/status`;
  }
  async sendSms(to: string, body: string) {
    const sender = this.cfg.env.TWILIO_MESSAGING_SERVICE_SID
      ? { messagingServiceSid: this.cfg.env.TWILIO_MESSAGING_SERVICE_SID }
      : { from: this.cfg.env.TWILIO_SMS_FROM };
    const m = await this.client.messages.create({ to, body, statusCallback: this.statusCallback, ...sender });
    return { sid: m.sid };
  }
  async sendWhatsApp(to: string, contentSid: string, variables: Record<string, string>) {
    if (!this.cfg.env.TWILIO_WHATSAPP_FROM) throw new Error('TWILIO_WHATSAPP_FROM is not set');
    const m = await this.client.messages.create({
      to: `whatsapp:${to}`,
      from: this.cfg.env.TWILIO_WHATSAPP_FROM,
      contentSid,
      contentVariables: JSON.stringify(variables),
      statusCallback: this.statusCallback,
    });
    return { sid: m.sid };
  }
}

export function createMessaging(cfg: AppConfig): MessagingProvider {
  return cfg.env.MESSAGING_PROVIDER === 'twilio' ? new TwilioMessaging(cfg) : new ConsoleMessaging();
}
