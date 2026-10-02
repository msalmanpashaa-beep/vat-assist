import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { AppConfig } from '../../config';
import { DomainError } from '../../common/errors';

type Purpose = 'access' | 'mfa';

@Injectable()
export class TokensService {
  private readonly key: Uint8Array;

  constructor(private readonly cfg: AppConfig) {
    this.key = new TextEncoder().encode(cfg.env.JWT_SECRET);
  }

  async sign(userId: string, purpose: Purpose, sessionId: string | null, ttlSeconds: number): Promise<string> {
    return new SignJWT({ typ: purpose, sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('vat-assist')
      .setAudience('vat-assist')
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string, purpose: Purpose): Promise<{ userId: string; sessionId: string | null }> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: 'vat-assist', audience: 'vat-assist' });
      if (payload.typ !== purpose || typeof payload.sub !== 'string') throw new Error('wrong token type');
      return { userId: payload.sub, sessionId: typeof payload.sid === 'string' ? payload.sid : null };
    } catch {
      throw new DomainError('unauthenticated', 'Your session has expired. Please sign in again.', 401);
    }
  }
}
