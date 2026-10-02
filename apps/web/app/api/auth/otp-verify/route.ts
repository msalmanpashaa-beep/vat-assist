import { NextResponse } from 'next/server';
import { API_URL, applySession, sameOrigin } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'Wrong origin.' }, { status: 403 });
  const res = await fetch(`${API_URL}/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: await req.text() });
  const data = await res.json();
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  return applySession(NextResponse.json({ ok: true }), data);
}
