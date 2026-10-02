import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dHash, hamming, NEAR_DUPLICATE_MAX_BITS } from '../src/modules/documents/fingerprint';
import { checkImageQuality } from '../src/modules/documents/quality';

/** Synthetic document photos: ruled lines plus a dense block; `variant` moves the big dark areas. */
const page = async (variant: 0 | 1, opts: { blur?: number; dark?: boolean } = {}) => {
  const band = variant === 0 ? '<rect x="0" y="0" width="1240" height="320" fill="#222"/>' : '<rect x="0" y="0" width="360" height="1754" fill="#222"/>';
  const rules = Array.from({ length: 24 }, (_, i) => `<line x1="420" x2="1180" y1="${380 + i * 52}" y2="${380 + i * 52}" stroke="#333" stroke-width="3"/>`).join('');
  const block = Array.from({ length: 400 }, (_, i) => ((i + Math.floor(i / 20)) % 2 ? '' : `<rect x="${800 + (i % 20) * 14}" y="${1400 + Math.floor(i / 20) * 14}" width="14" height="14" fill="#000"/>`)).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="1240" height="1754" fill="${opts.dark ? '#141414' : '#fafaf5'}"/>${band}${rules}${block}</svg>`;
  let img = sharp(Buffer.from(svg));
  if (opts.blur) img = img.blur(opts.blur);
  return img.jpeg({ quality: 85 }).toBuffer();
};

describe('photo quality and fingerprints', () => {
  it('a sharp, well-lit page passes; a blurred one is sent back for a retake', async () => {
    const good = await checkImageQuality(await page(0));
    expect(good.ok).toBe(true);
    const blurred = await checkImageQuality(await page(0, { blur: 16 }));
    expect(blurred.ok).toBe(false);
    expect(blurred.issues).toContain('blurred');
  });

  it('a page shot in the dark is rejected', async () => {
    const dark = await checkImageQuality(await page(0, { dark: true }));
    expect(dark.issues).toContain('too_dark');
  });

  it('a tiny image is rejected for resolution', async () => {
    const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    expect((await checkImageQuality(small)).issues).toContain('resolution_too_low');
  });

  it('the same page re-encoded is a near duplicate; a different layout is not', async () => {
    const a = await dHash(await page(0));
    const reencoded = await dHash(await sharp(await page(0)).resize(900).jpeg({ quality: 60 }).toBuffer());
    const other = await dHash(await page(1));
    expect(hamming(a, reencoded)).toBeLessThanOrEqual(NEAR_DUPLICATE_MAX_BITS);
    expect(hamming(a, other)).toBeGreaterThan(NEAR_DUPLICATE_MAX_BITS);
  });
});
