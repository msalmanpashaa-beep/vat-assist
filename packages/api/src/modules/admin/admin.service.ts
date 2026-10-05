import { Inject, Injectable, Logger } from '@nestjs/common';
import { type FeatureKey, FEATURE_KEYS, resolveFeatures, type StaffRole, todayIn } from '@vat-assist/shared';
import { randomBytes } from 'node:crypto';
import { AppConfig } from '../../config';
import { type Actor, userCtx } from '../../common/auth-context';
import { randomToken, sha256Hex } from '../../common/crypto';
import { forbidden, notFound } from '../../common/errors';
import { Db } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { MAIL_PROVIDER, MailError, type MailProvider } from '../mail/mail';
import { staffInviteEmail, testEmail } from '../mail/templates';
import { RemindersService } from '../notifications/reminders.service';
import { activation, churned, filingRecord, PILOT_TARGETS, type PilotPeriod, type PilotRow, quarterBounds, quarterOf, reviewerMinutes, scorecard } from './pilot-metrics';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const INVITE_DAYS = 7;

/** A one-time recovery code an admin can read out to a staff member: XXXXX-XXXXX, no look-alike characters. */
export function newRecoveryCode(): string {
  const chars = Array.from(randomBytes(10), (b) => CODE_ALPHABET.charAt(b % CODE_ALPHABET.length)).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export interface StaffRow {
  user_id: string; email: string; full_name: string | null; roles: string[] | null; totp_enabled: boolean; disabled: boolean;
  invite_pending: boolean; recovery_codes_left: number; client_count: number;
  /** The latest invite email: whether it went out, through which provider. */
  invite_email?: { status: 'sent' | 'failed'; provider: string; error: string | null; at: Date } | null;
}

const ROLE_LABEL: Record<StaffRole, string> = {
  reviewer: 'a reviewer', senior_reviewer: 'a senior reviewer (you sign off returns)', admin: 'an administrator', support: 'support staff',
};

/**
 * Nex-Gen administration. Every write goes through a SECURITY DEFINER function that re-checks the caller is a
 * platform admin, so the rule holds even if a route forgets to check. Actions are audited in the platform's
 * chain and, for client-specific changes, in that client's chain too.
 */
@Injectable()
export class AdminService {
  private readonly log = new Logger('Admin');

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly reminders: RemindersService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  async requireAdmin(a: Actor): Promise<void> {
    const r = await this.db.run(userCtx(a), (tx) => tx.one<{ ok: boolean }>(`select app.is_platform_admin() as ok`));
    if (!r.ok) throw forbidden('Only Nex-Gen platform admins can do this.');
  }

  private async platformId(): Promise<string> {
    const r = await this.db.run({ kind: 'system', orgId: null }, (tx) => tx.one<{ id: string }>(`select id from organisations where is_platform`));
    return r.id;
  }

  private async auditIn(orgId: string, action: string, entityType: string, entityId: string, a: Actor, payload: Record<string, unknown> = {}) {
    await this.db.run({ kind: 'system', orgId }, (tx) => this.audit.log(tx, action, entityType, entityId, { ...payload, by: a.userId }));
  }

  async staff(a: Actor): Promise<StaffRow[]> {
    await this.requireAdmin(a);
    return this.db.run(userCtx(a), async (tx) => {
      const rows = await tx.many<StaffRow>(`select * from app.admin_staff_list()`);
      const mails = await tx.many<{ related_user_id: string; status: 'sent' | 'failed'; provider: string; error: string | null; created_at: Date }>(
        `select distinct on (related_user_id) related_user_id, status, provider, error, created_at
         from email_messages where kind = 'staff_invite' order by related_user_id, created_at desc`,
      );
      const latest = new Map(mails.map((m) => [m.related_user_id, m]));
      return rows.map((r) => {
        const m = latest.get(r.user_id);
        return { ...r, invite_email: m ? { status: m.status, provider: m.provider, error: m.error, at: m.created_at } : null };
      });
    });
  }

  /** New staff (or an existing one's password reset): emails a one-time link, valid for 7 days, to set a password. */
  async invite(a: Actor, email: string, fullName: string, role: StaffRole, orgIds: string[] = []) {
    await this.requireAdmin(a);
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    const { user_id } = await this.db.run(userCtx(a), (tx) =>
      tx.one<{ user_id: string }>(`select app.admin_invite_staff($1, $2, $3, $4, $5) as user_id`, [email, fullName, role, sha256Hex(token), expiresAt]),
    );
    // Link the new person to the clients they will look after, in the same role.
    if (orgIds.length) {
      await this.db.run(userCtx(a), async (tx) => {
        for (const orgId of orgIds) await tx.exec(`select app.assign_staff($1, $2, $3)`, [orgId, user_id, role]);
      });
    }
    const inviteUrl = `${this.cfg.env.WEB_BASE_URL}/invite/${token}`;
    const inviter = await this.db.run(userCtx(a), (tx) =>
      tx.maybe<{ full_name: string | null; email: string | null }>(`select full_name, email::text as email from users where id = $1`, [a.userId]),
    );
    const content = staffInviteEmail({
      fullName, roleLabel: ROLE_LABEL[role], inviteUrl, expiresAt, invitedBy: inviter?.full_name ?? inviter?.email ?? null, clients: orgIds.length,
    });
    let delivery: { status: 'sent' | 'failed'; provider: string; messageId: string | null; error: string | null };
    try {
      const sent = await this.mail.send({ to: email, toName: fullName, ...content, tag: 'staff_invite', idempotencyKey: `staff-invite-${sha256Hex(token).slice(0, 32)}` });
      delivery = { status: 'sent', provider: sent.provider, messageId: sent.id, error: null };
    } catch (e) {
      const err = e instanceof MailError ? e : new MailError(e instanceof Error ? e.message : String(e), this.mail.name, true);
      this.log.warn(`Invite email to ${email} failed: ${err.message}`);
      delivery = { status: 'failed', provider: err.provider, messageId: null, error: err.message.slice(0, 500) };
    }
    await this.db.run(userCtx(a), (tx) =>
      tx.exec(
        `insert into email_messages (kind, to_email, subject, provider, provider_message_id, status, error, related_user_id, created_by)
         values ('staff_invite', $1, $2, $3, $4, $5, $6, $7, $8)`,
        [email, content.subject, delivery.provider, delivery.messageId, delivery.status, delivery.error, user_id, a.userId],
      ),
    );
    await this.auditIn(await this.platformId(), 'staff.invited', 'user', user_id, a, {
      email, role, clients: orgIds.length, emailStatus: delivery.status, provider: delivery.provider,
    });
    // The link travels only by email. If the email could not be sent, the admin gets it to pass on another way.
    return {
      userId: user_id,
      expiresAt,
      assignedClients: orgIds.length,
      email: { status: delivery.status, provider: delivery.provider, error: delivery.error },
      inviteUrl: delivery.status === 'failed' ? inviteUrl : null,
    };
  }

  /** Sends a test email (to the admin by default) through the configured provider, to prove the set-up works. */
  async testEmail(a: Actor, to?: string) {
    await this.requireAdmin(a);
    const me = await this.db.run(userCtx(a), (tx) => tx.one<{ email: string | null }>(`select email::text as email from users where id = $1`, [a.userId]));
    const recipient = to ?? me.email;
    if (!recipient) throw notFound('An email address for you');
    const content = testEmail({ provider: this.mail.name, sentAt: new Date() });
    let delivery: { status: 'sent' | 'failed'; provider: string; messageId: string | null; error: string | null };
    try {
      const sent = await this.mail.send({ to: recipient, ...content, tag: 'test' });
      delivery = { status: 'sent', provider: sent.provider, messageId: sent.id, error: null };
    } catch (e) {
      const err = e instanceof MailError ? e : new MailError(e instanceof Error ? e.message : String(e), this.mail.name, true);
      delivery = { status: 'failed', provider: err.provider, messageId: null, error: err.message.slice(0, 500) };
    }
    await this.db.run(userCtx(a), (tx) =>
      tx.exec(
        `insert into email_messages (kind, to_email, subject, provider, provider_message_id, status, error, related_user_id, created_by)
         values ('test', $1, $2, $3, $4, $5, $6, $7, $7)`,
        [recipient, content.subject, delivery.provider, delivery.messageId, delivery.status, delivery.error, a.userId],
      ),
    );
    await this.auditIn(await this.platformId(), 'mail.test_sent', 'user', a.userId, a, { to: recipient, status: delivery.status, provider: delivery.provider });
    return { to: recipient, status: delivery.status, provider: delivery.provider, error: delivery.error };
  }

  /** The pilot scorecard: activation, reviewer minutes, on-time filing, churn and referrals, per shop and overall. */
  async pilot(a: Actor, cohort: string | null, quarter: string | null) {
    await this.requireAdmin(a);
    const now = new Date();
    const today = todayIn(this.cfg.env.TZ_BUSINESS, now);
    const q = quarterBounds(quarter ?? quarterOf(today));
    const raw = await this.db.run(userCtx(a), (tx) =>
      tx.many<{
        org_id: string; org_name: string; cohort: string | null; signed_up_at: Date; files_electronically: boolean; opening_at: Date | null;
        docs_14d: number; sales_14d: number; last_owner_activity: Date | null; staff_action_times: Date[]; periods: PilotPeriod[];
        referrals: number; subscription_status: string | null;
      }>(`select * from app.admin_pilot_data($1, $2, $3)`, [cohort, q.from, q.to]),
    );
    const rows: PilotRow[] = raw.map((r) => ({
      orgId: r.org_id, orgName: r.org_name, cohort: r.cohort, signedUpAt: r.signed_up_at, filesElectronically: r.files_electronically,
      openingAt: r.opening_at, docs14d: r.docs_14d, sales14d: r.sales_14d, lastOwnerActivity: r.last_owner_activity,
      staffActionTimes: (r.staff_action_times ?? []).map((t) => new Date(t)), periods: r.periods ?? [], referrals: r.referrals,
      subscriptionStatus: r.subscription_status,
    }));
    return {
      cohort,
      quarter: q,
      targets: PILOT_TARGETS,
      scorecard: scorecard(rows, now, today),
      shops: rows.map((r) => ({
        orgId: r.orgId, orgName: r.orgName, cohort: r.cohort, signedUpAt: r.signedUpAt,
        activation: activation(r), reviewerMinutes: reviewerMinutes(r.staffActionTimes), filing: filingRecord(r, today),
        churned: churned(r, now), lastOwnerActivity: r.lastOwnerActivity, referrals: r.referrals,
      })),
    };
  }

  async setPilotCohort(a: Actor, orgId: string, cohort: string | null) {
    await this.requireAdmin(a);
    await this.db.run(userCtx(a), (tx) => tx.exec(`select app.admin_set_pilot_cohort($1, $2)`, [orgId, cohort]));
    await this.auditIn(orgId, 'pilot.cohort_set', 'organisation', orgId, a, { cohort });
    return { orgId, cohort };
  }

  async resendInvite(a: Actor, userId: string) {
    const row = (await this.staff(a)).find((s) => s.user_id === userId);
    if (!row) throw notFound('Staff member');
    return this.invite(a, row.email, row.full_name ?? row.email, (row.roles?.[0] ?? 'reviewer') as StaffRole);
  }

  async resetTwoFactor(a: Actor, userId: string) {
    await this.requireAdmin(a);
    await this.db.run(userCtx(a), (tx) => tx.exec(`select app.admin_reset_staff_2fa($1)`, [userId]));
    await this.auditIn(await this.platformId(), 'staff.2fa_reset', 'user', userId, a);
    return { userId, totpEnabled: false, message: 'They set up a new authenticator at their next sign-in. All their sessions were ended.' };
  }

  /** Temporary: one use, valid 24 hours. Shown once to the admin; only its hash is stored. */
  async recoveryCode(a: Actor, userId: string) {
    await this.requireAdmin(a);
    const code = newRecoveryCode();
    const { expires_at } = await this.db.run(userCtx(a), (tx) =>
      tx.one<{ expires_at: Date }>(`select app.admin_add_recovery_code($1, $2) as expires_at`, [userId, sha256Hex(code)]),
    );
    await this.auditIn(await this.platformId(), 'staff.recovery_code_issued', 'user', userId, a, { expiresAt: expires_at });
    return { userId, code, expiresAt: expires_at };
  }

  async setDisabled(a: Actor, userId: string, disabled: boolean) {
    await this.requireAdmin(a);
    await this.db.run(userCtx(a), (tx) => tx.exec(`select app.admin_set_staff_disabled($1, $2)`, [userId, disabled]));
    await this.auditIn(await this.platformId(), disabled ? 'staff.disabled' : 'staff.enabled', 'user', userId, a);
    return { userId, disabled };
  }

  async clients(a: Actor) {
    await this.requireAdmin(a);
    const rows = await this.db.run(userCtx(a), (tx) =>
      tx.many<{ org_id: string; org_name: string; legal_name: string; vat_number: string | null; created_at: Date; staff: Array<{ userId: string; name: string; email: string; role: string }>; features: Record<string, boolean> }>(
        `select * from app.admin_clients()`,
      ),
    );
    return rows.map((r) => ({ ...r, features: resolveFeatures(r.features) }));
  }

  async assign(a: Actor, orgId: string, userId: string, role: StaffRole) {
    await this.requireAdmin(a);
    await this.db.run(userCtx(a), (tx) => tx.one(`select app.assign_staff($1, $2, $3) as id`, [orgId, userId, role]));
    await this.auditIn(orgId, 'staff.assigned', 'user', userId, a, { role });
    return { orgId, userId, role };
  }

  async unassign(a: Actor, orgId: string, userId: string) {
    await this.requireAdmin(a);
    const { n } = await this.db.run(userCtx(a), (tx) => tx.one<{ n: number }>(`select app.admin_unassign_staff($1, $2) as n`, [orgId, userId]));
    if (n) await this.auditIn(orgId, 'staff.unassigned', 'user', userId, a);
    return { orgId, userId, removed: n };
  }

  /** Move many clients at once (e.g. a reviewer leaves): all-or-nothing in one transaction. */
  async bulkReassign(a: Actor, orgIds: string[], toUserId: string, role: StaffRole, fromUserId?: string) {
    await this.requireAdmin(a);
    await this.db.run(userCtx(a), async (tx) => {
      for (const orgId of orgIds) {
        if (fromUserId) await tx.exec(`select app.admin_unassign_staff($1, $2)`, [orgId, fromUserId]);
        await tx.exec(`select app.assign_staff($1, $2, $3)`, [orgId, toUserId, role]);
      }
    });
    for (const orgId of orgIds) await this.auditIn(orgId, 'staff.reassigned', 'user', toUserId, a, { role, from: fromUserId ?? null });
    return { reassigned: orgIds.length, toUserId, role, fromUserId: fromUserId ?? null };
  }

  async setFeatures(a: Actor, orgId: string, features: Partial<Record<FeatureKey, boolean>>) {
    await this.requireAdmin(a);
    const changes = FEATURE_KEYS.filter((k) => typeof features[k] === 'boolean').map((k) => [k, features[k] as boolean] as const);
    await this.db.run(userCtx(a), async (tx) => {
      for (const [k, v] of changes) await tx.exec(`select app.admin_set_feature($1, $2, $3)`, [orgId, k, v]);
    });
    if (features.invoice_reminders === false) await this.reminders.cancelInvoiceReminders(orgId);
    if (features.invoice_reminders === true) await this.reminders.scheduleInvoiceReminders(orgId);
    await this.auditIn(orgId, 'features.updated', 'organisation', orgId, a, Object.fromEntries(changes));
    return (await this.clients(a)).find((c) => c.org_id === orgId)?.features ?? resolveFeatures(null);
  }
}
