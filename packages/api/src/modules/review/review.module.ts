import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { VatModule } from '../vat/vat.module';
import { QueriesController } from './queries.controller';
import { QueriesService } from './queries.service';
import { ReviewerController } from './reviewer.controller';
import { ReviewerService } from './reviewer.service';

@Module({
  imports: [LedgerModule, VatModule],
  controllers: [QueriesController, ReviewerController],
  providers: [QueriesService, ReviewerService],
})
export class ReviewModule {}
