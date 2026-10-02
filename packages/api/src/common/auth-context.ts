import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@vat-assist/shared';
import type { DbContext } from '../db/db.service';

export interface Actor {
  userId: string;
  sessionId: string;
}

export interface OrgScope extends Actor {
  orgId: string;
  roles: Role[];
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  return ctx.switchToHttp().getRequest().actor as Actor;
});

export const CurrentScope = createParamDecorator((_: unknown, ctx: ExecutionContext): OrgScope => {
  return ctx.switchToHttp().getRequest().scope as OrgScope;
});

export const userCtx = (s: Actor | OrgScope): DbContext => ({
  kind: 'user',
  userId: s.userId,
  orgId: 'orgId' in s ? s.orgId : null,
});

export const STAFF_ROLES: Role[] = ['reviewer', 'senior_reviewer', 'admin'];
export const isStaff = (roles: Role[]) => roles.some((r) => STAFF_ROLES.includes(r));
