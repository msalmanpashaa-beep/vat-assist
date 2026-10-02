import { type NextRequest, NextResponse } from 'next/server';
import { ACCESS, API_URL, sameOrigin } from '@/lib/session';

/** Browser → this server → API, adding the bearer token from the httpOnly cookie. */
async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (req.method !== 'GET' && !sameOrigin(req)) return NextResponse.json({ message: 'Wrong origin.' }, { status: 403 });
  const token = req.cookies.get(ACCESS)?.value;
  if (!token) return NextResponse.json({ code: 'unauthenticated', message: 'Your session ended. Reload the page to sign in again.' }, { status: 401 });
  const { path } = await ctx.params;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const type = req.headers.get('content-type');
  if (type) headers['content-type'] = type;
  const res = await fetch(`${API_URL}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' ? undefined : await req.arrayBuffer(),
    cache: 'no-store',
  });
  const out = new Headers();
  for (const h of ['content-type', 'content-disposition']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new NextResponse(res.status === 204 ? null : res.body, { status: res.status, headers: out });
}

export { forward as GET, forward as POST, forward as PATCH };
