import { type NextRequest, NextResponse } from 'next/server';
import { API_URL, sameOrigin } from '@/lib/session';

const ACTIONS = new Set(['card', 'proof-upload', 'notify']);

/** Public pay page → API, passing the payer's IP so rate limits apply per person, not to this server. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string; action: string }> }) {
  if (!sameOrigin(req)) return NextResponse.json({ message: 'Wrong origin.' }, { status: 403 });
  const { token, action } = await ctx.params;
  if (!ACTIONS.has(action)) return NextResponse.json({ message: 'Not found.' }, { status: 404 });
  const forwarded = req.headers.get('x-forwarded-for');
  const res = await fetch(`${API_URL}/pay/${encodeURIComponent(token)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) },
    body: await req.text(),
    cache: 'no-store',
  });
  return new NextResponse(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
}
