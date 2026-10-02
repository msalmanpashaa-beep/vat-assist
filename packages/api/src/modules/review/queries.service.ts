import { Injectable } from '@nestjs/common';
import type { QueryCreateBody, QueryReplyBody } from '@vat-assist/shared';
import type { z } from 'zod';
import { isStaff, type OrgScope } from '../../common/auth-context';
import { conflict, notFound } from '../../common/errors';
import type { Tx } from '../../db/db.service';
import { AuditService } from '../core/audit.service';

/** Questions between the reviewer and the shop, attached to a document, transaction or period. */
@Injectable()
export class QueriesService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, orgId: string, status?: string) {
    return tx.many(
      `select q.id, q.status, q.blocking, q.period_id, q.transaction_id, q.document_id, q.raised_at, q.resolved_at,
              (q.raised_by is null) as automatic,
              (select m.body from query_messages m where m.query_id = q.id order by m.created_at limit 1) as first_message,
              (select m.body from query_messages m where m.query_id = q.id order by m.created_at desc limit 1) as last_message,
              (select count(*)::int from query_messages m where m.query_id = q.id) as message_count
       from queries q
       where q.org_id = $1 and ($2::text is null or q.status = $2)
       order by (q.status in ('open', 'answered')) desc, q.raised_at desc
       limit 200`,
      [orgId, status ?? null],
    );
  }

  async thread(tx: Tx, orgId: string, id: string) {
    const q = await tx.maybe(`select * from queries where id = $1 and org_id = $2`, [id, orgId]);
    if (!q) throw notFound('Question');
    const messages = await tx.many(
      `select m.id, m.body, m.attachment_document_id, m.created_at, u.full_name as author_name,
              coalesce(u.auth_method = 'email_password_totp', false) as from_reviewer, (m.author_id is null) as from_system
       from query_messages m left join users u on u.id = m.author_id
       where m.query_id = $1 order by m.created_at`,
      [id],
    );
    return { ...q, messages };
  }

  async create(tx: Tx, s: OrgScope, body: z.output<typeof QueryCreateBody>) {
    let periodId = body.periodId ?? null;
    let transactionId = body.transactionId ?? null;
    if (!transactionId && body.documentId) {
      const t = await tx.maybe<{ id: string }>(`select id from transactions where document_id = $1 and status <> 'void' limit 1`, [body.documentId]);
      transactionId = t?.id ?? null;
    }
    if (!periodId && transactionId) {
      const t = await tx.maybe<{ period_id: string | null }>(`select period_id from transactions where id = $1`, [transactionId]);
      periodId = t?.period_id ?? null;
    }
    const q = await tx.one<{ id: string }>(
      `insert into queries (org_id, period_id, transaction_id, document_id, blocking, raised_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [s.orgId, periodId, transactionId, body.documentId ?? null, body.blocking, s.userId],
    );
    await tx.exec(`insert into query_messages (org_id, query_id, author_id, body) values ($1, $2, $3, $4)`, [s.orgId, q.id, s.userId, body.body]);
    await this.audit.log(tx, 'query.raised', 'query', q.id, { blocking: body.blocking, documentId: body.documentId ?? null, transactionId });
    return { queryId: q.id };
  }

  async reply(tx: Tx, s: OrgScope, id: string, body: z.output<typeof QueryReplyBody>) {
    const q = await tx.maybe<{ id: string; status: string }>(`select id, status from queries where id = $1 and org_id = $2 for update`, [id, s.orgId]);
    if (!q) throw notFound('Question');
    if (q.status === 'resolved' || q.status === 'cancelled') throw conflict('query_closed', 'This question is already closed.');
    await tx.exec(
      `insert into query_messages (org_id, query_id, author_id, body, attachment_document_id) values ($1, $2, $3, $4, $5)`,
      [s.orgId, id, s.userId, body.body ?? null, body.attachmentDocumentId ?? null],
    );
    const fromShop = !isStaff(s.roles);
    const status = fromShop ? 'answered' : 'open';
    await tx.exec(`update queries set status = $2 where id = $1`, [id, status]);
    await this.audit.log(tx, 'query.replied', 'query', id, { fromShop });
    return { queryId: id, status };
  }

  async resolve(tx: Tx, s: OrgScope, id: string) {
    const n = await tx.exec(
      `update queries set status = 'resolved', resolved_by = $3, resolved_at = now() where id = $1 and org_id = $2 and status in ('open', 'answered')`,
      [id, s.orgId, s.userId],
    );
    if (!n) throw conflict('query_not_open', 'Only an open or answered question can be resolved.');
    await this.audit.log(tx, 'query.resolved', 'query', id);
    return { queryId: id, status: 'resolved' as const };
  }
}
