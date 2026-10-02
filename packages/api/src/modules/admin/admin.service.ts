import { Injectable, Logger } from '@nestjs/common';
import { type FeatureKey, FEATURE_KEYS, resolveFeatures, type StaffRole } from '@vat-assist/shared';
import { randomBytes } from 'node:crypto';
import { AppConfig } from '../../config';
import { type Actor, userCtx } from '../../common/auth-context';
import { randomToken, sha256Hex } from '../../common/crypto';
import { forbidden, notFound } from '../../common/errors';
import { Db } from '../../db/db.service';
import { AuditService } from '../core/audit.service';
import { RemindersService } from '../notifications/reminders.service';

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
}

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
    return this.db.run(userCtx(a), (tx) => tx.many<StaffRow>(`select * from app.admin_staff_list()`));
  }

  /** New staff (or an existing one's password reset): a one-time link, valid for 7 days, to set a password. */
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
    // No mail provider is configured yet: the link is logged and returned to the admin who sends it.
    this.log.log(`Invite for ${email} (${role}): ${inviteUrl}`);
    await this.auditIn(await this.platformId(), 'staff.invited', 'user', user_id, a, { email, role, clients: orgIds.length });
    return { userId: user_id, inviteUrl, expiresAt, assignedClients: orgIds.length };
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
