/** Browser → /api/proxy → API, as the signed-in user. Throws with the API's plain-language message. */
export async function send<T = unknown>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/proxy${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? `Failed (${res.status})`);
  return data as T;
}
