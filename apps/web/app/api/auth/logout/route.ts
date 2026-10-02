import { type NextRequest, NextResponse } from 'next/server';
import { ACCESS, API_URL, clearSession, sameOrigin } from '@/lib/session';

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'Wrong origin.' }, { status: 403 });
  const token = req.cookies.get(ACCESS)?.value;
  if (token) await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  return clearSession(NextResponse.redirect(new URL('/login', req.url), 303));
}
