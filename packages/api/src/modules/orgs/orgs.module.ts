import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({ imports: [LedgerModule], controllers: [OrgsController], providers: [OrgsService] })
export class OrgsModule {}
