import sharp from 'sharp';

export interface QualityReport {
  ok: boolean;
  issues: string[];
  width?: number;
  height?: number;
  blurScore?: number;
  brightness?: number;
  contrast?: number;
  pages?: number;
}

/** Heuristic thresholds: tune them on the first pilot shops' real photos. */
export const QUALITY = { minShortSide: 600, blurThreshold: 60, darkBelow: 45, minContrast: 12 };

/** Variance of the 4-neighbour Laplacian: sharp edges give high variance, blur gives low. */
export function laplacianVariance(px: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * (px[i] as number) - (px[i - 1] as number) - (px[i + 1] as number) - (px[i - w] as number) - (px[i + w] as number);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export async function checkImageQuality(buf: Buffer): Promise<QualityReport> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    return { ok: false, issues: ['unreadable_image'] };
  }
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  if (!width || !height) return { ok: false, issues: ['unreadable_image'] };
  const issues: string[] = [];
  if (Math.min(width, height) < QUALITY.minShortSide) issues.push('resolution_too_low');
  const { data, info } = await sharp(buf)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: 1000, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const grey = info.channels === 1 ? data : Uint8Array.from({ length: info.width * info.height }, (_, i) => data[i * info.channels] as number);
  const blurScore = Math.round(laplacianVariance(grey, info.width, info.height));
  let total = 0;
  for (const v of grey) total += v;
  const brightness = total / grey.length;
  let sq = 0;
  for (const v of grey) sq += (v - brightness) ** 2;
  const contrast = Math.sqrt(sq / grey.length);
  if (blurScore < QUALITY.blurThreshold) issues.push('blurred');
  if (brightness < QUALITY.darkBelow) issues.push('too_dark');
  if (contrast < QUALITY.minContrast) issues.push('low_contrast');
  return { ok: issues.length === 0, issues, width, height, blurScore, brightness: Math.round(brightness), contrast: Math.round(contrast) };
}

export function checkPdfBasic(buf: Buffer): QualityReport {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, issues: ['not_a_pdf'] };
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  const issues = pages > 10 ? ['too_many_pages'] : [];
  return { ok: issues.length === 0, issues, pages };
}
