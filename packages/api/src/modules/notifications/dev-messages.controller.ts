import { Controller, Get, Inject, NotFoundException, Query } from '@nestjs/common';
import { AppConfig } from '../../config';
import { Public } from '../../common/auth-context';
import { ConsoleMessaging, MESSAGING, type MessagingProvider } from './messaging';

/** Development only: the SMS and WhatsApp messages the console provider "sent" (demos and tests read them here). */
@Controller('dev/messages')
export class DevMessagesController {
  constructor(
    private readonly cfg: AppConfig,
    @Inject(MESSAGING) private readonly messaging: MessagingProvider,
  ) {}

  @Public()
  @Get('outbox')
  outbox(@Query('to') to?: string) {
    if (this.cfg.isProduction || !(this.messaging instanceof ConsoleMessaging)) throw new NotFoundException();
    return this.messaging.outbox.filter((m) => !to || m.to === to.trim());
  }
}
