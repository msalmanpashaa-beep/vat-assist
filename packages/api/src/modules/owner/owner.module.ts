import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OwnerController } from './owner.controller';

@Module({ imports: [NotificationsModule], controllers: [OwnerController] })
export class OwnerModule {}
