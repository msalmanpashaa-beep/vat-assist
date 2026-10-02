import { FeaturesService } from './features.service';
import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config';
import { Db } from '../../db/db.service';
import { AuditService } from './audit.service';
import { JobsService } from './jobs.service';
import { PeriodsService } from './periods.service';
import { RulesService } from './rules.service';
import { StorageService } from './storage.service';
import { TokensService } from './tokens.service';
import { AuthGuard, OrgGuard } from './guards';

const providers = [FeaturesService, Db, AuditService, JobsService, PeriodsService, RulesService, StorageService, TokensService, AuthGuard, OrgGuard];

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => AppConfig.fromEnv() }, ...providers],
  exports: [AppConfig, ...providers],
})
export class CoreModule {}
