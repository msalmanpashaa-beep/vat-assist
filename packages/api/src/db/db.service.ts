import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, types } from 'pg';
import { AppConfig } from '../config';

// bigint (int8) -> number, refusing values JavaScript cannot hold exactly. Money is integer cents.
types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
});
// date -> 'YYYY-MM-DD' string (pg would otherwise build a local-midnight Date and shift days).
types.setTypeParser(1082, (v: string) => v);
// numeric (e.g. sums of bigint, confidence scores): money stays in integer cents, so Number is exact here.
types.setTypeParser(1700, (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) throw new Error(`numeric out of safe range: ${v}`);
  return n;
});

/**
 * Every query runs inside a transaction that first declares who is asking. Row-level security policies
 * read these settings, so the database itself enforces tenant isolation.
 */
export type DbContext =
  | { kind: 'user'; userId: string; orgId?: string | null }
  | { kind: 'system'; orgId: string | null }
  | { kind: 'auth' };

export class Tx {
  constructor(private readonly client: PoolClient) {}

  async many<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.client.query(sql, params);
    return r.rows as T[];
  }

  async maybe<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.many<T>(sql, params);
    if (rows.length > 1) throw new Error(`Expected at most one row, got ${rows.length}`);
    return rows[0] ?? null;
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const row = await this.maybe<T>(sql, params);
    if (!row) throw new Error(`Expected one row, got none: ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
    return row;
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const r = await this.client.query(sql, params);
    return r.rowCount ?? 0;
  }

  /** Re-pin the transaction to an organisation (e.g. right after creating it). */
  async pinOrg(orgId: string): Promise<void> {
    await this.client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
  }

  async savepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.client.query(`savepoint ${name}`);
    try {
      const out = await fn();
      await this.client.query(`release savepoint ${name}`);
      return out;
    } catch (e) {
      await this.client.query(`rollback to savepoint ${name}`);
      throw e;
    }
  }
}

@Injectable()
export class Db implements OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly pool: Pool;

  constructor(cfg: AppConfig) {
    this.pool = new Pool({ connectionString: cfg.env.DATABASE_URL, max: 20 });
    this.pool.on('error', (e) => this.log.error(`idle client error: ${e.message}`));
  }

  async run<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.context', $1, true), set_config('app.user_id', $2, true), set_config('app.org_id', $3, true)`,
        [ctx.kind, ctx.kind === 'user' ? ctx.userId : '', ctx.kind === 'auth' ? '' : (ctx.orgId ?? '')],
      );
      const out = await fn(new Tx(client));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
