import { Client } from 'pg';
import { randomToken, sha256Hex } from '../common/crypto';
import { AppConfig } from '../config';
import { CHART_TEMPLATE } from '../modules/ledger/chart';
import { createMailProvider } from '../modules/mail/mail';
import { staffInviteEmail } from '../modules/mail/templates';

/**
 * Production bootstrap, run once per environment after migrations, from a trusted terminal (never CI logs):
 *   node packages/api/dist/scripts/bootstrap.js --platform-name "Nex-Gen Africa Ltd" --admin-email you@nex-gen.africa \
 *        --admin-name "Your Name" [--vat-number 12345678] [--email]
 *        [--juice-mobile +2305xxxxxxx] [--bank-name MCB] [--bank-account-name "..."] [--bank-account-number "..."]
 * The payment options are how shops pay Nex-Gen's booking deposits by Juice or bank transfer.
 * Creates the Nex-Gen platform organisation (with its chart of accounts) if it is missing, and a one-time invite for
 * the first admin to set a password and an authenticator. Prints the link, or emails it (--email). Re-running is
 * safe; once an admin has signed in it refuses, and further staff are invited from the admin console.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const platformName = arg('platform-name');
  const email = arg('admin-email')?.trim().toLowerCase();
  const name = arg('admin-name');
  const vatNumber = arg('vat-number');
  if (!platformName || !email || !name) throw new Error('Usage: bootstrap --platform-name "..." --admin-email you@domain --admin-name "Your Name" [--vat-number 12345678] [--email]');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Not an email address: ${email}`);
  if (vatNumber && !/^\d{8}$/.test(vatNumber)) throw new Error('--vat-number is the 8-digit VAT number');
  const cfg = AppConfig.fromEnv();
  const url = cfg.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is not set');
  const db = new Client({ connectionString: url });
  await db.connect();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  let created = false;
  try {
    await db.query('begin');
    let platform = (await db.query<{ id: string }>(`select id from organisations where is_platform`)).rows[0]?.id;
    if (!platform) {
      platform = (
        await db.query<{ id: string }>(
          `insert into organisations (legal_name, legal_form, vat_number, filing_frequency, start_date, is_platform)
           values ($1, 'company', $2, 'quarterly', (now() at time zone 'Indian/Mauritius')::date, true) returning id`,
          [platformName, vatNumber ?? null],
        )
      ).rows[0]!.id;
      created = true;
    }
    for (const a of CHART_TEMPLATE) {
      await db.query(`insert into accounts (org_id, code, name, type, system_tag) values ($1, $2, $3, $4, $5) on conflict (org_id, code) do nothing`, [platform, a.code, a.name, a.type, a.tag]);
    }
    const juice = arg('juice-mobile');
    const bankAccountNumber = arg('bank-account-number');
    if (juice || bankAccountNumber) {
      await db.query(`insert into payment_settings (org_id) values ($1) on conflict (org_id) do nothing`, [platform]);
      await db.query(
        `update payment_settings set juice_mobile = coalesce($2, juice_mobile), juice_name = coalesce($3, juice_name),
                bank_name = coalesce($4, bank_name), bank_account_name = coalesce($5, bank_account_name),
                bank_account_number = coalesce($6, bank_account_number), updated_at = now() where org_id = $1`,
        [platform, juice ?? null, juice ? platformName : null, arg('bank-name') ?? null, arg('bank-account-name') ?? null, bankAccountNumber ?? null],
      );
    }
    const active = await db.query(
      `select 1 from memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.role = 'admin' and m.revoked_at is null and u.password_hash is not null and u.disabled_at is null`,
      [platform],
    );
    if (active.rowCount) throw new Error('An admin already exists. Invite further staff from Admin → Staff.');
    const existing = (await db.query<{ id: string; auth_method: string }>(`select id, auth_method from users where email = $1::citext`, [email])).rows[0];
    if (existing && existing.auth_method !== 'email_password_totp') throw new Error('That email belongs to a shop owner account; use another address.');
    const userId = existing?.id ?? (await db.query<{ id: string }>(`insert into users (auth_method, email, full_name) values ('email_password_totp', $1, $2) returning id`, [email, name])).rows[0]!.id;
    await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'admin') on conflict do nothing`, [platform, userId]);
    await db.query(`update staff_invites set expires_at = now() where user_id = $1 and accepted_at is null and expires_at > now()`, [userId]);
    await db.query(`insert into staff_invites (user_id, token_hash, expires_at, created_by) values ($1, $2, $3, $1)`, [userId, sha256Hex(token), expiresAt]);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');
    throw e;
  } finally {
    await db.end();
  }
  const inviteUrl = `${cfg.env.WEB_BASE_URL}/invite/${token}`;
  console.log(created ? `Created the platform organisation "${platformName}".` : 'The platform organisation already exists.');
  if (process.argv.includes('--email')) {
    const content = staffInviteEmail({ fullName: name, roleLabel: 'an administrator', inviteUrl, expiresAt, invitedBy: null, clients: 0 });
    const sent = await createMailProvider(cfg).send({ to: email, toName: name, ...content, tag: 'staff_invite' });
    console.log(`Invite emailed to ${email} through ${sent.provider}. It works once and expires in 7 days.`);
  } else {
    console.log(`First admin invite for ${email} (works once, expires in 7 days). Open it to set a password and an authenticator:\n${inviteUrl}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
