import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ErrorFilter } from './common/errors';
import { HealthController } from './health.controller';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { CoreModule } from './modules/core/core.module';
import { MailModule } from './modules/mail/mail.module';
import { AuthGuard } from './modules/core/guards';
import { DocumentsModule } from './modules/documents/documents.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrgsModule } from './modules/orgs/orgs.module';
import { OwnerModule } from './modules/owner/owner.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ReviewModule } from './modules/review/review.module';
import { VatModule } from './modules/vat/vat.module';

/**
 * Modular monolith: one deployable, modules with clear boundaries. Each module could become its own
 * service later; the database already isolates tenants with row-level security.
 */
@Module({
  imports: [
    CoreModule, MailModule, AuthModule, OrgsModule, LedgerModule, DocumentsModule, VatModule,
    ReviewModule, PaymentsModule, NotificationsModule, AdminModule, OwnerModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
