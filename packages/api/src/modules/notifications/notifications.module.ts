import { DevMessagesController } from './dev-messages.controller';
import { Module } from '@nestjs/common';
import { AppConfig } from '../../config';
import { VatModule } from '../vat/vat.module';
import { createMessaging, MESSAGING } from './messaging';
import { RemindersService } from './reminders.service';
import { TwilioWebhooksController } from './twilio.controller';

@Module({
  imports: [VatModule],
  controllers: [TwilioWebhooksController, DevMessagesController],
  providers: [RemindersService, { provide: MESSAGING, inject: [AppConfig], useFactory: createMessaging }],
  exports: [RemindersService],
})
export class NotificationsModule {}
