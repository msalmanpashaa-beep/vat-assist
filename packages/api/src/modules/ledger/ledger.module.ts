import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  controllers: [TransactionsController],
  providers: [LedgerService, TransactionsService],
  exports: [LedgerService, TransactionsService],
})
export class LedgerModule {}
