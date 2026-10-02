import type { ReactNode } from 'react';
import { vi } from 'vitest';

export const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));

export interface Call { url: string; method: string; body: unknown }
export const calls: Call[] = [];

/** Every request the screen makes is recorded; the reply comes from `respond`. */
export function mockApi(respond: (url: string, method: string) => unknown = () => ({})): void {
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(respond(url, method) ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
