import { NextResponse } from 'next/server';
import { API_URL, applySession, sameOrigin } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'Wrong origin.' }, { status: 403 });
  const { mfaToken, code } = (await req.json()) as { mfaToken: string; code: string };
  const res = await fetch(`${API_URL}/auth/staff/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mfaToken}` },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  return applySession(NextResponse.json({ ok: true, recoveryCodes: data.recoveryCodes ?? null }), data);
}
