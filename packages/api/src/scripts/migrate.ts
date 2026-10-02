import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Applies migrations/NNNN_*.sql in order, once each, as the schema owner (DATABASE_OWNER_URL).
 * A migration that changed after it was applied stops the run: write a new migration instead.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is not set');
  const dir = join(__dirname, '..', '..', 'migrations');
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(`create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const applied = new Map((await db.query<{ name: string; checksum: string }>(`select name, checksum from schema_migrations`)).rows.map((r) => [r.name, r.checksum]));
    let count = 0;
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const prev = applied.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`${f} changed after it was applied. Add a new migration instead of editing it.`);
        continue;
      }
      await db.query('begin');
      try {
        await db.query(sql);
        await db.query(`insert into schema_migrations (name, checksum) values ($1, $2)`, [f, sum]);
        await db.query('commit');
      } catch (e) {
        await db.query('rollback');
        throw new Error(`${f} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(`applied ${f}`);
      count++;
    }
    console.log(count ? `${count} migration(s) applied` : 'database is up to date');
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
