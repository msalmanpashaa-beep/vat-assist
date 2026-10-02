import { argon2id, hash } from 'argon2';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSecret, generateURI } from 'otplib';
import { Client } from 'pg';
import { decrypt, encrypt } from '../common/crypto';
import { AppConfig } from '../config';
import { CHART_TEMPLATE } from '../modules/ledger/chart';

/**
 * Development seed: reference data, the Nex-Gen platform organisation and three Nex-Gen staff logins
 * (admin, reviewer, senior reviewer) with authenticator secrets. Everything here is fictional.
 * The shop itself is created through the API by the demo script, the same way a real owner signs up.
 */
const STAFF = [
  { email: 'admin@nexgen.test', name: 'Demo Admin', role: 'admin', password: 'Admin-Demo-2026!' },
  { email: 'reviewer@nexgen.test', name: 'Demo Reviewer', role: 'reviewer', password: 'Reviewer-Demo-2026!' },
  { email: 'senior@nexgen.test', name: 'Demo Senior Reviewer ACA', role: 'senior_reviewer', password: 'Senior-Demo-2026!' },
] as const;

async function main(): Promise<void> {
  const cfg = AppConfig.fromEnv();
  if (cfg.isProduction) throw new Error('The demo seed must never run in production.');
  const url = cfg.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is not set');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(await readFile(join(__dirname, '..', '..', 'seeds', '01_reference.sql'), 'utf8'));

    let platform = (await db.query<{ id: string }>(`select id from organisations where is_platform`)).rows[0]?.id;
    if (!platform) {
      // 99999901 is a placeholder VAT number (real TANs do not start with 9). Replace with Nex-Gen's own.
      platform = (
        await db.query<{ id: string }>(
          `insert into organisations (legal_name, trading_name, legal_form, vat_number, filing_frequency, start_date, is_platform)
           values ('Nex-Gen Africa Ltd (demo)', 'Nex-Gen Africa', 'company', '99999901', 'quarterly', '2026-07-01', true) returning id`,
        )
      ).rows[0]!.id;
    }
    for (const a of CHART_TEMPLATE) {
      await db.query(
        `insert into accounts (org_id, code, name, type, system_tag) values ($1, $2, $3, $4, $5) on conflict (org_id, code) do nothing`,
        [platform, a.code, a.name, a.type, a.tag],
      );
    }

    // Fictional Nex-Gen payment details for the demo; replace with the real accounts.
    await db.query(
      `insert into payment_settings (org_id, juice_mobile, juice_name, bank_name, bank_account_name, bank_account_number, card_provider)
       values ($1, '+23057100009', 'Nex-Gen Africa Ltd', 'MCB', 'Nex-Gen Africa Ltd', '000 444 555 666', 'stripe') on conflict (org_id) do nothing`,
      [platform],
    );

    const out = [];
    for (const s of STAFF) {
      let row = (await db.query<{ id: string; totp_secret_enc: string }>(`select id, totp_secret_enc from users where email = $1`, [s.email])).rows[0];
      if (!row) {
        const secret = generateSecret();
        row = (
          await db.query<{ id: string; totp_secret_enc: string }>(
            `insert into users (auth_method, email, full_name, password_hash, totp_secret_enc, totp_enabled_at)
             values ('email_password_totp', $1, $2, $3, $4, now()) returning id, totp_secret_enc`,
            [s.email, s.name, await hash(s.password, { type: argon2id }), encrypt(cfg.encryptionKey, secret)],
          )
        ).rows[0]!;
        await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, $3) on conflict do nothing`, [platform, row.id, s.role]);
      }
      const secret = decrypt(cfg.encryptionKey, row.totp_secret_enc);
      out.push({ ...s, userId: row.id, totpSecret: secret, otpauthUri: generateURI({ issuer: 'VAT Assist (Nex-Gen)', label: s.email, secret }) });
    }
    const dir = join(process.cwd(), 'demo-output');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'staff-credentials.json'), JSON.stringify({ platformOrgId: platform, staff: out }, null, 2));
    console.log(`Seeded platform organisation ${platform}`);
    for (const s of out) console.log(`  ${s.role.padEnd(16)} ${s.email}  password ${s.password}  (TOTP secret in demo-output/staff-credentials.json)`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
