import { Logger } from '@nestjs/common';
import type { Locale } from '@vat-assist/shared';
import twilio from 'twilio';
import type { AppConfig } from '../../config';

/** Sends and checks the 6-digit SMS code for owners and cashiers. */
export interface OtpProvider {
  start(phoneE164: string, locale: Locale): Promise<void>;
  check(phoneE164: string, code: string): Promise<boolean>;
}

/** Development only: no SMS is sent and the fixed code is accepted. The API refuses this in production. */
class DevOtpProvider implements OtpProvider {
  private readonly log = new Logger('DevOtp');
  constructor(private readonly code: string) {}
  async start(phone: string): Promise<void> {
    this.log.warn(`No SMS sent (dev). Sign in ${phone} with code ${this.code}`);
  }
  async check(_phone: string, code: string): Promise<boolean> {
    return code === this.code;
  }
}

/** Twilio Verify handles code generation, expiry, retry limits and fraud checks. */
class TwilioVerifyOtpProvider implements OtpProvider {
  private readonly client: ReturnType<typeof twilio>;
  constructor(private readonly cfg: AppConfig) {
    if (!cfg.env.TWILIO_ACCOUNT_SID || !cfg.env.TWILIO_AUTH_TOKEN || !cfg.env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error('OTP_PROVIDER=twilio-verify needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID');
    }
    this.client = twilio(cfg.env.TWILIO_ACCOUNT_SID, cfg.env.TWILIO_AUTH_TOKEN);
  }
  private get service() {
    return this.client.verify.v2.services(this.cfg.env.TWILIO_VERIFY_SERVICE_SID as string);
  }
  async start(phone: string, locale: Locale): Promise<void> {
    // Verify has no Kreol template; French is the closest supported language.
    await this.service.verifications.create({ to: phone, channel: 'sms', locale: locale === 'mfe' ? 'fr' : locale });
  }
  async check(phone: string, code: string): Promise<boolean> {
    const r = await this.service.verificationChecks.create({ to: phone, code });
    return r.status === 'approved';
  }
}

export function createOtpProvider(cfg: AppConfig): OtpProvider {
  return cfg.env.OTP_PROVIDER === 'twilio-verify'
    ? new TwilioVerifyOtpProvider(cfg)
    : new DevOtpProvider(cfg.env.OTP_DEV_FIXED_CODE ?? '000000');
}
