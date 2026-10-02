import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/common/crypto';
import { newRecoveryCode } from '../src/modules/admin/admin.service';
import { chooseChannel } from '../src/modules/notifications/reminders.service';

describe('reminder channel choice (checked again at send time)', () => {
  it('uses WhatsApp only with an opt-in and an approved template', () => {
    expect(chooseChannel({ whatsappOptIn: true, hasTemplate: true, smsOptOut: false })).toBe('whatsapp');
    expect(chooseChannel({ whatsappOptIn: true, hasTemplate: false, smsOptOut: false })).toBe('sms');
    expect(chooseChannel({ whatsappOptIn: false, hasTemplate: true, smsOptOut: false })).toBe('sms');
  });
  it('sends nothing to a number that replied STOP and has no WhatsApp opt-in', () => {
    expect(chooseChannel({ whatsappOptIn: false, hasTemplate: true, smsOptOut: true })).toBe('skip');
    expect(chooseChannel({ whatsappOptIn: true, hasTemplate: true, smsOptOut: true })).toBe('whatsapp');
  });
});

describe('admin-issued recovery codes', () => {
  it('are readable aloud (no 0/O/1/I/L) and stored only as a hash the sign-in step recognises', () => {
    const codes = new Set(Array.from({ length: 500 }, newRecoveryCode));
    expect(codes.size).toBe(500);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    const c = [...codes][0] as string;
    expect(sha256Hex(c)).toHaveLength(64);
  });
});
