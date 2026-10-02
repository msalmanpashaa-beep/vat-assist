import sharp from 'sharp';

/**
 * 64-bit difference hash. Two photos of the same paper invoice usually differ by a few bits;
 * different invoices differ by many. Stored as bit(64) so Postgres compares with bit_count(a # b).
 */
export async function dHash(buf: Buffer): Promise<string> {
  const { data, info } = await sharp(buf)
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const l = data[(y * 9 + x) * ch] as number;
      const r = data[(y * 9 + x + 1) * ch] as number;
      bits += l > r ? '1' : '0';
    }
  }
  return bits;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d + Math.abs(a.length - b.length);
}

export const NEAR_DUPLICATE_MAX_BITS = 6;
