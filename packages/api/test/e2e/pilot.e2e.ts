/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { call, invoicePhoto, ownerLogin, snap, staffCredentials, staffLogin } from '../../src/scripts/http';

/** Pilot scorecard end to end: cohort tagging, activation, reviewer minutes, referrals, admin-only access. */
const run = String(Date.now()).slice(-6);
const phone = (k: number) => `+23057${String((Number(run) + k * 7919) % 1_000_000).padStart(6, '0')}`;
const cohort = `e2e-${run}`;
let admin = '';
let reviewer = '';
let reviewerId = '';
const shop: Record<'a' | 'b' | 'c', { token: string; orgId: string; code: string }> = {} as never;

async function newShop(key: 'a' | 'b' | 'c', k: number, referralCode?: string) {
  const token = await ownerLogin(phone(k));
  const org = await call('POST', '/orgs', { token, body: { legalName: `Pilot ${key.toUpperCase()} ${run} Ltd`, legalForm: 'company', startDate: '2026-07-01', ...(referralCode ? { referralCode } : {}) } });
  shop[key] = { token, orgId: org.orgId, code: org.referralCode };
  return org;
}

beforeAll(async () => {
  const creds = staffCredentials();
  const a = creds.staff.find((s) => s.role === 'admin')!;
  const r = creds.staff.find((s) => s.role === 'reviewer')!;
  admin = await staffLogin(a.email, a.password, a.totpSecret);
  reviewer = await staffLogin(r.email, r.password, r.totpSecret);
  reviewerId = r.userId;
});

describe('pilot scorecard', () => {
  it('each shop gets a referral code; a new shop can quote it', async () => {
    const a = await newShop('a', 1);
    expect(a.referralCode).toMatch(/^NX[0-9A-Z]{6}$/);
    await newShop('b', 2);
    const c = await newShop('c', 3, shop.a.code.toLowerCase());
    expect(c.referred).toBe(true);
  });

  it('shop A activates: opening balances, five documents and a day of sales', async () => {
    const { token, orgId } = shop.a;
    await call('POST', `/orgs/${orgId}/opening-balances`, { token, body: { cashInHandCents: 500_000, bankBalances: [], stockCents: 0, customersOwe: [], suppliersOwed: [] } });
    for (let i = 1; i <= 5; i++) await snap(token, orgId, `pilot-${run}-${i}.jpg`, await invoicePhoto(`Pilot ${i}`));
    await call('POST', `/orgs/${orgId}/daily-takings`, { token, body: { date: '2026-09-12', lines: [{ method: 'cash', vatCode: 'SR', grossCents: 115_000 }] } });
  });

  it('a reviewer works on shop A, which counts toward reviewer minutes', async () => {
    await call('POST', `/admin/orgs/${shop.a.orgId}/staff`, { token: admin, body: { userId: reviewerId, role: 'reviewer' } });
    await call('POST', `/orgs/${shop.a.orgId}/queries`, { token: reviewer, body: { body: 'Is the cash float included in cash in hand?', blocking: false } });
  });

  it('the admin tags A and B into the cohort; the scorecard measures them against the targets', async () => {
    for (const k of ['a', 'b'] as const) await call('PUT', `/admin/orgs/${shop[k].orgId}/pilot`, { token: admin, body: { cohort } });
    const p = await call('GET', `/admin/pilot?cohort=${cohort}`, { token: admin });
    expect(p.shops.map((s: any) => s.orgId).sort()).toEqual([shop.a.orgId, shop.b.orgId].sort());
    const a = p.shops.find((s: any) => s.orgId === shop.a.orgId);
    const b = p.shops.find((s: any) => s.orgId === shop.b.orgId);
    expect(a.activation).toEqual({ activated: true, missing: [] });
    expect(b.activation.missing).toEqual(['opening balances', '5 more document(s)', 'a day of sales']);
    expect(a.reviewerMinutes).toBeGreaterThanOrEqual(3);
    expect(b.reviewerMinutes).toBe(0);
    expect(a.referrals).toBe(1);
    expect(p.targets).toMatchObject({ shops: 10, reviewerMinutesPerShopQuarter: 20 });
    expect(p.scorecard.shops).toMatchObject({ value: 2, pass: false });
    expect(p.scorecard.activationRate).toMatchObject({ value: 0.5, activated: 1 });
    expect(p.scorecard.referrals.value).toBe(1);
  });

  it('only Nex-Gen admins can see or change the pilot; bad cohort names are refused', async () => {
    await call('GET', `/admin/pilot?cohort=${cohort}`, { token: reviewer, expect: [403] });
    await call('PUT', `/admin/orgs/${shop.b.orgId}/pilot`, { token: admin, body: { cohort: 'Bad Name!' }, expect: [400] });
    await call('PUT', `/admin/orgs/${shop.b.orgId}/pilot`, { token: admin, body: { cohort: null } });
    expect((await call('GET', `/admin/pilot?cohort=${cohort}`, { token: admin })).shops).toHaveLength(1);
  });
});
