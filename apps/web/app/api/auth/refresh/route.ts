import { type NextRequest, NextResponse } from 'next/server';
import { API_URL, applySession, clearSession, REFRESH } from '@/lib/session';

/** Swap the refresh cookie for a new pair (rotation), then go back to where the user was. */
export async function GET(req: NextRequest) {
  const asked = req.nextUrl.searchParams.get('next') ?? '/';
  const next = asked.startsWith('/') && !asked.startsWith('//') ? asked : '/';
  const login = new URL(next.startsWith('/owner') ? '/owner/login' : '/login', req.url);
  const token = req.cookies.get(REFRESH)?.value;
  if (!token) return NextResponse.redirect(login);
  const res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) });
  if (!res.ok) return clearSession(NextResponse.redirect(login));
  return applySession(NextResponse.redirect(new URL(next, req.url)), await res.json());
}
