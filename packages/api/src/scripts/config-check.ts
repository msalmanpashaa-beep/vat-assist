import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { AppConfig, type Env, EnvSchema } from '../config';

/**
 * Checks a production env file before deploying.
 *   template mode (.env.production.example): every setting is listed, filled values are valid, the production rules
 *     hold, and what is still <to fill> is listed.
 *   real mode (.env.production): nothing may still be <to fill>, and the API must accept the file as it would at start.
 */
export interface ConfigReport {
  missingKeys: string[];
  toFill: string[];
  invalid: string[];
  providerGaps: string[];
  productionProblems: string[];
  unknownKeys: string[];
  ok: boolean;
}

const PLACEHOLDER = /^<[^>]*>$/;
const SAFE_BASE = { DATABASE_URL: 'postgres://placeholder', JWT_SECRET: 'x'.repeat(64), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };

/** Settings a chosen provider needs (a <to fill> value counts as provided in template mode). */
function providerGaps(v: Record<string, string>, provided: (k: string) => boolean): string[] {
  const need = (cond: boolean, label: string, keys: string[]) => (cond ? keys.filter((k) => !provided(k)).map((k) => `${label} needs ${k}`) : []);
  const gaps = [
    ...need(v.OTP_PROVIDER === 'twilio-verify', 'OTP_PROVIDER=twilio-verify', ['TWILIO_VERIFY_SERVICE_SID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']),
    ...need(v.STORAGE_DRIVER === 's3', 'STORAGE_DRIVER=s3', ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']),
    ...need(v.EXTRACTION_PROVIDER === 'anthropic', 'EXTRACTION_PROVIDER=anthropic', ['ANTHROPIC_API_KEY']),
    ...need(v.MESSAGING_PROVIDER === 'twilio', 'MESSAGING_PROVIDER=twilio', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']),
    ...need(v.MAIL_PROVIDER === 'smtp', 'MAIL_PROVIDER=smtp', ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']),
    ...need(v.MAIL_PROVIDER === 'postmark', 'MAIL_PROVIDER=postmark', ['POSTMARK_SERVER_TOKEN']),
    ...need(v.MAIL_PROVIDER === 'resend', 'MAIL_PROVIDER=resend', ['RESEND_API_KEY']),
    ...need(v.MAIL_PROVIDER === 'm365', 'MAIL_PROVIDER=m365', ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'M365_SENDER']),
    ...need(!!v.STRIPE_SECRET_KEY, 'Stripe', ['STRIPE_WEBHOOK_SECRET']),
  ];
  if (v.MESSAGING_PROVIDER === 'twilio' && !provided('TWILIO_SMS_FROM') && !provided('TWILIO_MESSAGING_SERVICE_SID')) {
    gaps.push('MESSAGING_PROVIDER=twilio needs TWILIO_SMS_FROM or TWILIO_MESSAGING_SERVICE_SID');
  }
  return gaps;
}

export function checkEnvText(text: string, template: boolean): ConfigReport {
  const raw = parseEnv(text) as Record<string, string>;
  const shape = EnvSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ message: string }> } } }>;
  const keys = Object.keys(shape);
  const missingKeys = keys.filter((k) => !(k in raw));
  const unknownKeys = Object.keys(raw).filter((k) => !(k in shape));
  const toFill = keys.filter((k) => PLACEHOLDER.test((raw[k] ?? '').trim()));
  const filled: Record<string, string> = Object.fromEntries(
    Object.entries(raw).filter(([k, v]) => k in shape && v.trim() !== '' && !PLACEHOLDER.test(v.trim())),
  );
  const invalid: string[] = [];
  const parsed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filled)) {
    const r = shape[k]!.safeParse(v);
    if (r.success) parsed[k] = r.data;
    else invalid.push(`${k}: ${r.error?.issues[0]?.message ?? 'invalid'}`);
  }
  const provided = (k: string) => k in filled || (template && toFill.includes(k));
  const gaps = providerGaps({ ...filled }, provided);
  // Production rules, with defaults for anything not set and <to fill> secrets assumed to arrive.
  const env = { ...EnvSchema.parse(SAFE_BASE), ...parsed, NODE_ENV: 'production' } as Env;
  const productionProblems = AppConfig.productionProblems(env);
  if (!template) {
    try {
      AppConfig.fromEnv({ ...filled, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!productionProblems.some((p) => msg.includes(p))) productionProblems.push(msg.split('\n')[0]!.slice(0, 300));
    }
  }
  const ok = !missingKeys.length && !invalid.length && !gaps.length && !productionProblems.length && (template || !toFill.length);
  return { missingKeys, toFill: template ? toFill : toFill.map((k) => `${k} is still a placeholder`), invalid, providerGaps: gaps, productionProblems, unknownKeys, ok };
}

function main(): void {
  const args = process.argv.slice(2);
  const template = args.includes('--template');
  const file = args.find((a) => !a.startsWith('--')) ?? '.env.production';
  const r = checkEnvText(readFileSync(file, 'utf8'), template);
  const section = (title: string, items: string[]) => items.length && console.log(`\n${title}\n${items.map((i) => `  - ${i}`).join('\n')}`);
  console.log(`${file}: ${r.ok ? 'OK' : 'NOT READY'}${template ? ' (template)' : ''}`);
  section('Settings missing from the file:', r.missingKeys);
  section('Invalid values:', r.invalid);
  section('Provider settings missing:', r.providerGaps);
  section('Production rules broken:', r.productionProblems);
  section(template ? 'Secrets and account details to fill on the host:' : 'Still placeholders:', r.toFill);
  section('Unknown settings (typo?):', r.unknownKeys);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) main();
