import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { FilingService } from './filing.service';
import { ReturnsService } from './returns.service';
import { VatController } from './vat.controller';
import { VatPotService } from './vat-pot.service';

@Module({
  imports: [LedgerModule],
  controllers: [VatController],
  providers: [VatPotService, ReturnsService, FilingService],
  exports: [VatPotService, ReturnsService],
})
export class VatModule {}
