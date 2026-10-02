import { Module } from '@nestjs/common';
import { AppConfig } from '../../config';
import { LedgerModule } from '../ledger/ledger.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CARD_GATEWAYS, createCardGateways } from './card';
import { createMipsClient, MIPS_CLIENT } from './mips';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [LedgerModule, NotificationsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    { provide: MIPS_CLIENT, inject: [AppConfig], useFactory: createMipsClient },
    { provide: CARD_GATEWAYS, inject: [AppConfig, MIPS_CLIENT], useFactory: createCardGateways },
  ],
})
export class PaymentsModule {}
