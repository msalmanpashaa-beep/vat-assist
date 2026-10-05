import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth-context';
import { Db } from './db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: Db) {}

  @Public()
  @Get()
  async health() {
    const r = await this.db.run({ kind: 'auth' }, (tx) => tx.one<{ now: Date }>(`select now()`));
    return { ok: true, database: 'up', time: r.now, version: process.env.GIT_SHA ?? 'dev' };
  }
}
