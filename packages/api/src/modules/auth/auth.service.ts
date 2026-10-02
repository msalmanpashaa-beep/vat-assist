import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { generateSecret, generateURI, verify } from 'otplib';
import type { Locale, MeResponse, SessionTokens } from '@vat-assist/shared';
import { AppConfig } from '../../config';
import { decrypt, encrypt, randomToken, sha256Hex } from '../../common/crypto';
import { DomainError, conflict, forbidden } from '../../common/errors';
import { Db, type Tx } from '../../db/db.service';
import { TokensService } from '../core/tokens.service';
import { createOtpProvider, type OtpProvider } from './otp.provider';
import { RateLimiter } from './rate-limit';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const invalidCode = () => new DomainError('invalid_code', 'That code is not right or has expired.', 401);

@Injectable()
export class AuthService {
  private readonly otp: OtpProvider;
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly tokens: TokensService,
  ) {
    this.otp = createOtpProvider(cfg);
  }

  normalisePhone(raw: string): string {
    const p = parsePhoneNumberFromString(raw, 'MU');
    if (!p || !p.isValid()) throw new DomainError('invalid_phone', 'Enter a valid mobile number, for example 5712 3456.', 400);
    return p.number;
  }

  // ---------- Owners and cashiers: phone + SMS code ----------

  async startOtp(rawPhone: string, meta: RequestMeta): Promise<void> {
    const phone = this.normalisePhone(rawPhone);
    this.limiter.hit(`otp-start:${phone}`, 5, 3_600_000);
    this.limiter.hit(`otp-start-ip:${meta.ip}`, 30, 3_600_000);
    const user = await this.db.run({ kind: 'auth' }, (tx) =>
      tx.maybe<{ auth_method: string; locale: Locale }>(`select auth_method, locale from users where phone_e164 = $1`, [phone]),
    );
    if (user && user.auth_method !== 'phone_otp') return; // staff sign in with email; reveal nothing
    await this.otp.start(phone, user?.locale ?? 'en');
  }

  async verifyOtp(rawPhone: string, code: string, locale: Locale | undefined, meta: RequestMeta): Promise<SessionTokens> {
    const phone = this.normalisePhone(rawPhone);
    this.limiter.hit(`otp-verify:${phone}`, 10, 3_600_000);
    if (!(await this.otp.check(phone, code))) throw invalidCode();
    return this.db.run({ kind: 'auth' }, async (tx) => {
      type UserRow = { id: string; auth_method: string; disabled_at: Date | null };
      const found = await tx.maybe<UserRow>(`select id, auth_method, disabled_at from users where phone_e164 = $1`, [phone]);
      const user =
        found ??
        (await tx.one<UserRow>(
          `insert into users (auth_method, phone_e164, locale) values ('phone_otp', $1, $2) returning id, auth_method, disabled_at`,
          [phone, locale ?? 'en'],
        ));
      if (user.auth_method !== 'phone_otp' || user.disabled_at) throw forbidden('This number cannot sign in here.');
      return this.createSession(tx, user.id, meta);
    });
  }

  // ---------- Nex-Gen staff: email + password, then an authenticator app ----------

  async staffLogin(email: string, password: string, meta: RequestMeta): Promise<{ mfaToken: string; totpEnrolled: boolean }> {
    this.limiter.hit(`staff-login:${email.toLowerCase()}`, 10, 900_000);
    this.limiter.hit(`staff-login-ip:${meta.ip}`, 50, 900_000);
    const u = await this.db.run({ kind: 'auth' }, (tx) =>
      tx.maybe<{ id: string; password_hash: string; totp_enabled_at: Date | null; disabled_at: Date | null }>(
        `select id, password_hash, totp_enabled_at, disabled_at from users where email = $1 and auth_method = 'email_password_totp'`,
        [email],
      ),
    );
    const ok = !!u && !u.disabled_at && (await argon2.verify(u.password_hash, password));
    if (!ok || !u) throw new DomainError('invalid_credentials', 'Email or password is not right.', 401);
    return { mfaToken: await this.tokens.sign(u.id, 'mfa', null, 300), totpEnrolled: !!u.totp_enabled_at };
  }

  async totpSetup(mfaToken: string): Promise<{ otpauthUri: string; secret: string }> {
    const { userId } = await this.tokens.verify(mfaToken, 'mfa');
    return this.db.run({ kind: 'auth' }, async (tx) => {
      const u = await tx.one<{ email: string; totp_enabled_at: Date | null }>(`select email, totp_enabled_at from users where id = $1`, [userId]);
      if (u.totp_enabled_at) throw conflict('totp_already_enabled', 'An authenticator app is already set up for this account.');
      const secret = generateSecret();
      await tx.exec(`update users set totp_pending_enc = $2 where id = $1`, [userId, encrypt(this.cfg.encryptionKey, secret)]);
      return { otpauthUri: generateURI({ issuer: 'VAT Assist (Nex-Gen)', label: u.email, secret }), secret };
    });
  }

  async totpVerify(mfaToken: string, code: string, meta: RequestMeta): Promise<SessionTokens & { recoveryCodes?: string[] }> {
    const { userId } = await this.tokens.verify(mfaToken, 'mfa');
    this.limiter.hit(`totp:${userId}`, 10, 900_000);
    return this.db.run({ kind: 'auth' }, async (tx) => {
      const u = await tx.one<{ totp_secret_enc: string | null; totp_pending_enc: string | null; totp_enabled_at: Date | null; recovery_code_hashes: string[] }>(
        `select totp_secret_enc, totp_pending_enc, totp_enabled_at, recovery_code_hashes from users where id = $1 for update`,
        [userId],
      );
      let recoveryCodes: string[] | undefined;
      if (u.totp_enabled_at && u.totp_secret_enc) {
        if (/^\d{6}$/.test(code)) {
          const r = await verify({ secret: decrypt(this.cfg.encryptionKey, u.totp_secret_enc), token: code });
          if (!r.valid) throw invalidCode();
        } else {
          const h = sha256Hex(code);
          if (!u.recovery_code_hashes.includes(h)) throw invalidCode();
          await tx.exec(`update users set recovery_code_hashes = array_remove(recovery_code_hashes, $2) where id = $1`, [userId, h]);
        }
      } else if (u.totp_pending_enc) {
        const r = await verify({ secret: decrypt(this.cfg.encryptionKey, u.totp_pending_enc), token: code });
        if (!r.valid) throw invalidCode();
        recoveryCodes = Array.from({ length: 8 }, () => {
          const s = randomBytes(8).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(10, 'X').slice(0, 10);
          return `${s.slice(0, 5)}-${s.slice(5)}`;
        });
        await tx.exec(
          `update users set totp_secret_enc = totp_pending_enc, totp_pending_enc = null, totp_enabled_at = now(), recovery_code_hashes = $2 where id = $1`,
          [userId, recoveryCodes.map(sha256Hex)],
        );
      } else {
        throw conflict('totp_not_set_up', 'Set up your authenticator app first.');
      }
      return { ...(await this.createSession(tx, userId, meta)), recoveryCodes };
    });
  }

  // ---------- Sessions: short access tokens, rotating refresh tokens with reuse detection ----------

  private async createSession(tx: Tx, userId: string, meta: RequestMeta, familyId: string = randomUUID()): Promise<SessionTokens> {
    const refreshToken = randomToken(32);
    const s = await tx.one<{ id: string }>(
      `insert into auth_sessions (user_id, family_id, refresh_token_hash, expires_at, user_agent, ip)
       values ($1, $2, $3, now() + make_interval(days => $4), $5, $6::inet) returning id`,
      [userId, familyId, sha256Hex(refreshToken), this.cfg.env.REFRESH_TOKEN_TTL_DAYS, meta.userAgent, meta.ip],
    );
    const ttl = this.cfg.env.ACCESS_TOKEN_TTL_SECONDS;
    return { accessToken: await this.tokens.sign(userId, 'access', s.id, ttl), refreshToken, expiresIn: ttl };
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<SessionTokens> {
    const out = await this.db.run({ kind: 'auth' }, async (tx) => {
      const s = await tx.maybe<{ id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null }>(
        `select id, user_id, family_id, expires_at, revoked_at from auth_sessions where refresh_token_hash = $1 for update`,
        [sha256Hex(refreshToken)],
      );
      if (!s) return { error: 'unknown' as const };
      if (s.revoked_at) {
        // A rotated token was used again: assume theft and end every session in the family.
        await tx.exec(`update auth_sessions set revoked_at = coalesce(revoked_at, now()) where family_id = $1`, [s.family_id]);
        return { error: 'reused' as const };
      }
      if (s.expires_at.getTime() < Date.now()) return { error: 'expired' as const };
      const tokens = await this.createSession(tx, s.user_id, meta, s.family_id);
      await tx.exec(
        `update auth_sessions set revoked_at = now(), replaced_by = (select id from auth_sessions where refresh_token_hash = $2) where id = $1`,
        [s.id, sha256Hex(tokens.refreshToken)],
      );
      return { tokens };
    });
    if ('error' in out) throw new DomainError('session_ended', 'Your session has ended. Please sign in again.', 401);
    return out.tokens;
  }

  async logout(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    await this.db.run({ kind: 'auth' }, (tx) => tx.exec(`update auth_sessions set revoked_at = now() where id = $1 and revoked_at is null`, [sessionId]));
  }

  async me(userId: string): Promise<MeResponse> {
    return this.db.run({ kind: 'user', userId }, async (tx) => {
      const u = await tx.one<{ id: string; full_name: string | null; phone_e164: string | null; email: string | null; locale: Locale }>(
        `select id, full_name, phone_e164, email, locale from users where id = $1`,
        [userId],
      );
      const memberships = await tx.many<{ org_id: string; org_name: string; role: MeResponse['memberships'][number]['role'] }>(
        `select m.org_id, coalesce(o.trading_name, o.legal_name) as org_name, m.role
         from memberships m join organisations o on o.id = m.org_id
         where m.user_id = $1 and m.revoked_at is null order by o.legal_name`,
        [userId],
      );
      return {
        user: { id: u.id, fullName: u.full_name, phone: u.phone_e164, email: u.email, locale: u.locale },
        memberships: memberships.map((m) => ({ orgId: m.org_id, orgName: m.org_name, role: m.role })),
      };
    });
  }

  async updateMe(userId: string, patch: { locale?: Locale; fullName?: string; whatsappOptIn?: boolean }): Promise<void> {
    await this.db.run({ kind: 'user', userId }, (tx) =>
      tx.exec(
        `update users set locale = coalesce($2, locale), full_name = coalesce($3, full_name),
                whatsapp_opt_in_at = case when $4::boolean is null then whatsapp_opt_in_at when $4 then now() else null end
         where id = $1`,
        [userId, patch.locale ?? null, patch.fullName ?? null, patch.whatsappOptIn ?? null],
      ),
    );
  }
}
