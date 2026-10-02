import type { FeatureSet } from '@vat-assist/shared';

/** Shared test doubles: the API, the router and the per-business feature flags. */
export const mockApi = jest.fn();
export const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const allOn = (): FeatureSet => ({ opening_balances: true, credit_invoices: true, record_payments: true, invoice_reminders: true, whatsapp_opt_in: true });
export const state: { params: Record<string, string>; features: FeatureSet } = { params: {}, features: allOn() };

/** Translations resolve to their keys (plus variables), so tests do not depend on wording. */
export const tr = (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

type Init = { method?: string; body?: unknown } | undefined;
/** Answers API calls by path fragment; anything unexpected fails the test. */
export function route(handlers: Record<string, (init: Init) => unknown>) {
  mockApi.mockImplementation(async (path: string, init?: Init) => {
    for (const [fragment, handler] of Object.entries(handlers)) if (path.includes(fragment)) return handler(init);
    throw new Error(`unexpected API call ${path}`);
  });
}

export function bodyOf(fragment: string): Record<string, any> {
  const call = mockApi.mock.calls.find((c) => String(c[0]).includes(fragment) && c[1]?.body !== undefined);
  if (!call) throw new Error(`no call with a body to ${fragment}`);
  return call[1].body;
}

export function reset() {
  mockApi.mockReset();
  for (const f of Object.values(mockRouter)) f.mockReset();
  state.params = {};
  state.features = allOn();
}
