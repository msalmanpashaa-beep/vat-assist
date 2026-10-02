import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db.service';

/** Appends to the per-organisation hash chain (app.append_audit). The transaction must be pinned to an org. */
@Injectable()
export class AuditService {
  async log(tx: Tx, action: string, entityType: string, entityId: string | null, data?: Record<string, unknown>): Promise<void> {
    await tx.exec(`select app.append_audit($1, $2, $3, $4::jsonb)`, [
      action,
      entityType,
      entityId,
      data === undefined ? null : JSON.stringify(data),
    ]);
  }

  async verify(tx: Tx, orgId: string): Promise<{ ok: boolean; checked: number; firstBadSeq: number | null }> {
    const r = await tx.one<{ ok: boolean; checked: number; first_bad_seq: number | null }>(
      `select * from app.verify_audit_chain($1)`,
      [orgId],
    );
    return { ok: r.ok, checked: r.checked, firstBadSeq: r.first_bad_seq };
  }

  async head(tx: Tx, orgId: string): Promise<{ seq: number; hash: string } | null> {
    return tx.maybe(`select seq, hash from audit_events where org_id = $1 order by seq desc limit 1`, [orgId]);
  }
}
