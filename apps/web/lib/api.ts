import { redirect } from 'next/navigation';
import { API_URL, accessToken } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { code?: string; message?: string } | null,
  ) {
    super(body?.message ?? `The server answered ${status}`);
  }
}

/** Server-side call to the API as the signed-in user. An expired session refreshes and comes back here. */
export async function api<T>(path: string, returnTo: string): Promise<T> {
  const refresh = `/api/auth/refresh?next=${encodeURIComponent(returnTo)}`;
  const token = await accessToken();
  if (!token) redirect(refresh);
  const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (res.status === 401) redirect(refresh);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
