import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { DevController } from './dev.controller';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentProcessor } from './processor.service';

@Module({
  imports: [LedgerModule],
  controllers: [DocumentsController, DevController],
  providers: [DocumentsService, DocumentProcessor],
  exports: [DocumentsService],
})
export class DocumentsModule {}
