import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@vat-assist/shared';
import { DomainError, forbidden, notFound } from '../../common/errors';
import { IS_PUBLIC, ROLES } from '../../common/auth-context';
import { Db } from '../../db/db.service';
import { TokensService } from './tokens.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Global: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new DomainError('unauthenticated', 'Sign in first.', 401);
    const claims = await this.tokens.verify(header.slice(7), 'access');
    req.actor = { userId: claims.userId, sessionId: claims.sessionId };
    return true;
  }
}

/**
 * For routes under /orgs/:orgId: checks membership, enforces @Roles(...), and exposes the scope.
 * The same membership rule is enforced again by row-level security in Postgres.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const orgId: string = req.params.orgId;
    if (!UUID.test(orgId ?? '')) throw notFound('Organisation');
    const rows = await this.db.run({ kind: 'user', userId: req.actor.userId, orgId }, (tx) =>
      tx.many<{ role: Role }>(
        `select role from memberships where org_id = $1 and user_id = $2 and revoked_at is null`,
        [orgId, req.actor.userId],
      ),
    );
    const roles = rows.map((r) => r.role);
    if (!roles.length) throw notFound('Organisation');
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (required && !roles.some((r) => required.includes(r))) {
      throw forbidden(`This needs one of these roles: ${required.join(', ')}.`);
    }
    req.scope = { ...req.actor, orgId, roles };
    return true;
  }
}
