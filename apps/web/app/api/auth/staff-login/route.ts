import { NextResponse } from 'next/server';
import { API_URL, sameOrigin } from '@/lib/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'Wrong origin.' }, { status: 403 });
  const res = await fetch(`${API_URL}/auth/staff/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: await req.text() });
  return NextResponse.json(await res.json(), { status: res.status });
}
