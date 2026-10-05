import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvText } from '../src/scripts/config-check';

const template = readFileSync(join(__dirname, '..', '..', '..', '.env.production.example'), 'utf8');
const set = (text: string, key: string, value: string) => text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);

describe('production settings check', () => {
  it('the committed template lists every setting, passes the production rules, and names the secrets to fill', () => {
    const r = checkEnvText(template, true);
    expect(r).toMatchObject({ ok: true, missingKeys: [], invalid: [], providerGaps: [], productionProblems: [], unknownKeys: [] });
    expect(r.toFill).toEqual(expect.arrayContaining(['DATABASE_URL', 'JWT_SECRET', 'DATA_ENCRYPTION_KEY', 'SMTP_PASS', 'TWILIO_AUTH_TOKEN']));
    expect(r.toFill).not.toContain('SMTP_USER');
  });

  it('keeps connect@nex-gen.africa as the sender for now', () => {
    expect(template).toMatch(/^SMTP_USER=connect@nex-gen\.africa$/m);
    expect(template).toMatch(/^MAIL_FROM="Nex-Gen Africa <connect@nex-gen\.africa>"$/m);
  });

  it('a real file with placeholders left in is not ready', () => {
    const r = checkEnvText(template, false);
    expect(r.ok).toBe(false);
    expect(r.toFill.join(' ')).toContain('SMTP_PASS is still a placeholder');
  });

  it('catches missing settings, bad values, broken production rules and provider gaps', () => {
    let text = template.replace(/^REDIS_URL=.*\n/m, '');
    text = set(text, 'SMTP_PORT', 'abc');
    text = set(text, 'PUBLIC_BASE_URL', 'http://api.nex-gen.africa');
    text = set(text, 'SMTP_HOST', '');
    text += '\nSMTP_PASWORD=typo\n';
    const r = checkEnvText(text, true);
    expect(r.ok).toBe(false);
    expect(r.missingKeys).toEqual(['REDIS_URL']);
    expect(r.invalid.join(' ')).toContain('SMTP_PORT');
    expect(r.productionProblems).toContain('PUBLIC_BASE_URL must be https');
    expect(r.providerGaps).toContain('MAIL_PROVIDER=smtp needs SMTP_HOST');
    expect(r.unknownKeys).toEqual(['SMTP_PASWORD']);
  });

  it('a fully filled file passes as the API itself would at start', () => {
    let text = template;
    const fill: Record<string, string> = {
      DATABASE_URL: 'postgres://vat_app:x@db.example.net:5432/vat_assist', DATABASE_OWNER_URL: 'postgres://vat_owner:x@db.example.net:5432/vat_assist',
      JWT_SECRET: 'j'.repeat(96), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), TWILIO_VERIFY_SERVICE_SID: 'VA123', S3_BUCKET: 'docs',
      S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 'secret', ANTHROPIC_API_KEY: 'sk-ant-x', REDIS_URL: 'rediss://default:x@redis.example.net:6379',
      SMTP_PASS: 'mailbox-pass', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15005550006',
    };
    for (const [k, v] of Object.entries(fill)) text = set(text, k, v);
    expect(checkEnvText(text, false)).toMatchObject({ ok: true, toFill: [], productionProblems: [] });
  });
});
