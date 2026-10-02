import { NextResponse } from 'next/server';
import { API_URL, sameOrigin } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'Wrong origin.' }, { status: 403 });
  const { mfaToken } = (await req.json()) as { mfaToken: string };
  const res = await fetch(`${API_URL}/auth/staff/totp/setup`, { method: 'POST', headers: { authorization: `Bearer ${mfaToken}` } });
  return NextResponse.json(await res.json(), { status: res.status });
}
