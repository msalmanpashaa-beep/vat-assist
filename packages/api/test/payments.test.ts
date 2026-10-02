import { describe, expect, it } from 'vitest';
import { buildPosting } from '../src/modules/ledger/posting-rules';
import { MockMipsClient } from '../src/modules/payments/mips';
import { extractCrypted, mockImn } from '../src/modules/payments/payments.service';
import { newPayToken, newReference, RAIL_METHOD, REFERENCE_ALPHABET } from '../src/modules/payments/rails';

describe('payment rails', () => {
  it('references are short, unambiguous and fit a transfer narration', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const r = newReference();
      expect(r).toMatch(/^VA[0-9A-Z]{6}$/);
      for (const c of r.slice(2)) expect(REFERENCE_ALPHABET).toContain(c);
      expect(r.slice(2)).not.toMatch(/[01OIL]/);
      seen.add(r);
    }
    expect(seen.size).toBeGreaterThan(1990);
  });

  it('pay link tokens carry 192 bits and are URL-safe', () => {
    expect(newPayToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('every rail posts to its own account', () => {
    const accountFor = (method: (typeof RAIL_METHOD)[keyof typeof RAIL_METHOD]) =>
      buildPosting({ kind: 'receipt', settlement: 'cash', paymentMethod: method, contactId: 'c', grossCents: 1000, lines: [], standardRateBp: 1500 })
        .find((l) => l.debit === 1000)?.account;
    expect(accountFor(RAIL_METHOD.juice)).toEqual({ tag: 'juice_clearing' });
    expect(accountFor(RAIL_METHOD.bank_transfer)).toEqual({ tag: 'bank' });
    expect(accountFor(RAIL_METHOD.mips)).toEqual({ tag: 'mips_clearing' });
    expect(accountFor(RAIL_METHOD.stripe)).toEqual({ tag: 'stripe_clearing' });
  });

  it('reads the MIPS IMN payload from JSON, form, or a raw body', () => {
    expect(extractCrypted({ crypted_callback: ' abc ' }, undefined, 'crypted_callback')).toBe('abc');
    expect(extractCrypted({ custom: 'xyz' }, undefined, 'custom')).toBe('xyz');
    expect(extractCrypted('raw-text', undefined, 'crypted_callback')).toBe('raw-text');
    expect(extractCrypted({}, Buffer.from('from-raw'), 'crypted_callback')).toBe('from-raw');
    expect(extractCrypted({}, undefined, 'crypted_callback')).toBeNull();
  });

  it('the development MIPS stand-in round-trips an IMN and refuses garbage', async () => {
    const mips = new MockMipsClient('http://localhost:4000');
    const d = await mips.decryptImn(MockMipsClient.encrypt(mockImn('VAK5S8G4-01', 100_000)));
    expect(d).toMatchObject({ id_order: 'VAK5S8G4-01', amount: '1000.00', currency: 'MUR', status: 'success' });
    await expect(mips.decryptImn('forged-notification')).rejects.toThrow();
  });
});
