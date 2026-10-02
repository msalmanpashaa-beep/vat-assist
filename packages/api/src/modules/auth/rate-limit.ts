import { DomainError } from '../../common/errors';

/**
 * Sliding-window limiter for sign-in endpoints. In-memory is enough for one API instance;
 * with several instances move this to Redis (same interface).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  hit(key: string, max: number, windowMs: number): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      throw new DomainError('too_many_attempts', 'Too many attempts. Wait a few minutes and try again.', 429);
    }
    recent.push(now);
    this.hits.set(key, recent);
  }
}
