import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';
export const ACCESS = 'va_at';
export const REFRESH = 'va_rt';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const base = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' };

/** Tokens live in httpOnly cookies; the browser never sees them, and every API call goes through this server. */
export function applySession(res: NextResponse, t: SessionTokens): NextResponse {
  res.cookies.set(ACCESS, t.accessToken, { ...base, maxAge: Math.max(60, t.expiresIn - 30) });
  res.cookies.set(REFRESH, t.refreshToken, { ...base, maxAge: 30 * 86_400 });
  return res;
}

export function clearSession(res: NextResponse): NextResponse {
  res.cookies.set(ACCESS, '', { ...base, maxAge: 0 });
  res.cookies.set(REFRESH, '', { ...base, maxAge: 0 });
  return res;
}

export async function accessToken(): Promise<string | null> {
  return (await cookies()).get(ACCESS)?.value ?? null;
}

/** Same-origin check for state-changing route handlers (cookies are SameSite=Lax as well). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  return new URL(origin).host === new URL(req.url).host;
}
