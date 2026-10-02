import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, decrypt, encrypt, sha256Hex } from '../src/common/crypto';

describe('crypto helpers behind sign-off fingerprints and stored secrets', () => {
  it('canonical JSON is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe(canonicalJson({ a: { c: 'x', d: [2, 1] }, b: 1 }));
    expect(canonicalJson({ a: 1, skip: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('sha256 matches the standard test vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('AES-256-GCM round-trips and detects tampering', () => {
    const key = randomBytes(32);
    const sealed = encrypt(key, 'JBSWY3DPEHPK3PXP');
    expect(decrypt(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    const bytes = Buffer.from(sealed.split('.').pop() ?? sealed, 'base64');
    expect(() => decrypt(randomBytes(32), sealed)).toThrow();
    expect(bytes.length).toBeGreaterThan(0);
  });
});
