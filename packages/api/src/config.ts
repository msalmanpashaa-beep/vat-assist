import { z } from 'zod';

const optional = z.string().min(1).optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  TZ_BUSINESS: z.string().default('Indian/Mauritius'),
  DATABASE_URL: z.string().min(1),
  DATABASE_OWNER_URL: optional,
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: z.string().min(40, 'DATA_ENCRYPTION_KEY must be 32 bytes, base64'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OTP_PROVIDER: z.enum(['dev', 'twilio-verify']).default('dev'),
  OTP_DEV_FIXED_CODE: optional,
  TWILIO_VERIFY_SERVICE_SID: optional,
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage-dev'),
  S3_BUCKET: optional,
  S3_REGION: z.string().default('af-south-1'),
  S3_ENDPOINT: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  EXTRACTION_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: optional,
  EXTRACTION_MODEL: z.string().default('claude-sonnet-5-5'),
  AUTO_POST_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  REDIS_URL: optional,
  /** Reverse proxies in front of the API (load balancer, the web app's /api/pay relay). Used for per-client rate limits. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  PAYMENTS_MODE: z.enum(['mock', 'live']).default('mock'),
  /** Staff invite emails. console prints them (development); postmark, resend or m365 send them. */
  MAIL_PROVIDER: z.enum(['console', 'smtp', 'postmark', 'resend', 'm365']).default('console'),
  /** Sender for Postmark and Resend (a verified domain or sender signature). Microsoft 365 sends as M365_SENDER. */
  MAIL_FROM: z.string().min(3).default('VAT Assist <no-reply@localhost>'),
  MAIL_REPLY_TO: optional,
  /** A mailbox on your own mail server (e.g. cPanel hosting). Port 465 = TLS from the start; 587 = STARTTLS. */
  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  /** Defaults to implicit on 465, otherwise starttls. none is for a local test server only (refused in production). */
  SMTP_TLS: z.enum(['implicit', 'starttls', 'none']).optional(),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  POSTMARK_SERVER_TOKEN: optional,
  POSTMARK_MESSAGE_STREAM: z.string().default('outbound'),
  POSTMARK_API_URL: z.string().url().default('https://api.postmarkapp.com'),
  RESEND_API_KEY: optional,
  RESEND_API_URL: z.string().url().default('https://api.resend.com'),
  M365_TENANT_ID: optional,
  M365_CLIENT_ID: optional,
  M365_CLIENT_SECRET: optional,
  M365_SENDER: optional,
  M365_LOGIN_URL: z.string().url().default('https://login.microsoftonline.com'),
  M365_GRAPH_URL: z.string().url().default('https://graph.microsoft.com'),
  MIPS_API_URL: z.string().url().default('https://api.mips.mu/api'),
  MIPS_ID_MERCHANT: optional,
  MIPS_ID_ENTITY: optional,
  MIPS_ID_OPERATOR: optional,
  MIPS_OPERATOR_PASSWORD: optional,
  MIPS_SALT: optional,
  MIPS_CIPHER_KEY: optional,
  MIPS_BASIC_AUTH_USER: optional,
  MIPS_BASIC_AUTH_PASS: optional,
  MIPS_IMN_FIELD: z.string().default('crypted_callback'),
  MIPS_IMN_PATH_SECRET: optional,
  MIPS_TOUCHPOINT: z.string().default('web'),
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_dev_only_secret'),
  DEPOSIT_DEFAULT_CENTS: z.coerce.number().int().positive().default(2500),
  MESSAGING_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_SMS_FROM: optional,
  TWILIO_MESSAGING_SERVICE_SID: optional,
  TWILIO_WHATSAPP_FROM: optional,
  TWILIO_WHATSAPP_CONTENT_SIDS: z.string().default('{}'),
  REMINDER_SEND_HOUR_LOCAL: z.coerce.number().int().min(0).max(23).default(9),
});

export type Env = z.infer<typeof EnvSchema>;

export class AppConfig {
  constructor(readonly env: Env) {}

  static fromEnv(raw: NodeJS.ProcessEnv = process.env): AppConfig {
    // Treat KEY= (empty) as "not set".
    const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== ''));
    const env = EnvSchema.parse(cleaned);
    const problems = AppConfig.productionProblems(env);
    if (problems.length) throw new Error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
    return new AppConfig(env);
  }

  static productionProblems(env: Env): string[] {
    if (env.NODE_ENV !== 'production') return [];
    const p: string[] = [];
    if (env.OTP_PROVIDER === 'dev' || env.OTP_DEV_FIXED_CODE) p.push('dev OTP provider / fixed code is not allowed');
    if (env.STORAGE_DRIVER !== 's3') p.push('STORAGE_DRIVER must be s3');
    if (env.EXTRACTION_PROVIDER === 'mock') p.push('EXTRACTION_PROVIDER must not be mock');
    if (env.PAYMENTS_MODE === 'mock') p.push('PAYMENTS_MODE must be live');
    if (env.MESSAGING_PROVIDER === 'console') p.push('MESSAGING_PROVIDER must not be console');
    if (env.MAIL_PROVIDER === 'console') p.push('MAIL_PROVIDER must be smtp, postmark, resend or m365');
    if (env.MAIL_PROVIDER === 'smtp' && env.SMTP_TLS === 'none') p.push('SMTP_TLS=none is not allowed in production');
    if (['smtp', 'postmark', 'resend'].includes(env.MAIL_PROVIDER) && /@(localhost|example\.com)\b/.test(env.MAIL_FROM)) {
      p.push('MAIL_FROM must be a real, verified sender address');
    }
    if (!env.PUBLIC_BASE_URL.startsWith('https://')) p.push('PUBLIC_BASE_URL must be https');
    if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET === 'whsec_dev_only_secret') p.push('STRIPE_WEBHOOK_SECRET must be set');
    return p;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get encryptionKey(): Buffer {
    const key = Buffer.from(this.env.DATA_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must decode to exactly 32 bytes');
    return key;
  }

  get whatsappContentSids(): Record<string, Record<string, string>> {
    try {
      return JSON.parse(this.env.TWILIO_WHATSAPP_CONTENT_SIDS) as Record<string, Record<string, string>>;
    } catch {
      throw new Error('TWILIO_WHATSAPP_CONTENT_SIDS must be JSON');
    }
  }
}
