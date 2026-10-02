import { Controller, Get, Inject, NotFoundException, Query } from '@nestjs/common';
import { AppConfig } from '../../config';
import { Public } from '../../common/auth-context';
import { ConsoleMail, MAIL_PROVIDER, type MailProvider } from './mail';

/** Development only: what the console provider "sent", so developers and the e2e tests can follow invite links. */
@Controller('dev/mail')
export class DevMailController {
  constructor(
    private readonly cfg: AppConfig,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  @Public()
  @Get('outbox')
  outbox(@Query('to') to?: string) {
    if (this.cfg.isProduction || !(this.mail instanceof ConsoleMail)) throw new NotFoundException();
    const want = to?.trim().toLowerCase();
    return this.mail.outbox.filter((m) => !want || m.to.toLowerCase() === want);
  }
}
