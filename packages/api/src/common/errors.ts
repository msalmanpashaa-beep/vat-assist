import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** An expected business-rule failure, shown to the user. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('not_found', `${what} not found`, 404);
export const forbidden = (why: string) => new DomainError('forbidden', why, 403);
export const conflict = (code: string, why: string, details?: unknown) => new DomainError(code, why, 409, details);

interface PgError {
  code?: string;
  message: string;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof HttpException) {
      res.status(err.getStatus()).json({ error: 'http_error', message: err.message });
      return;
    }
    const pg = err as PgError;
    // Database rules (triggers, RLS, constraints) are the last line of defence; report them plainly.
    if (pg?.code === 'P0001' || pg?.code === '23514') {
      res.status(409).json({ error: 'rule_violation', message: pg.message });
      return;
    }
    if (pg?.code === '23505') {
      res.status(409).json({ error: 'duplicate', message: 'This record already exists.' });
      return;
    }
    if (pg?.code === '42501') {
      res.status(403).json({ error: 'forbidden', message: 'You do not have access to this.' });
      return;
    }
    this.log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    res.status(500).json({ error: 'internal', message: 'Something went wrong. It has been logged.' });
  }
}
