import { Injectable } from '@nestjs/common';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppConfig } from '../../config';
import { hmacHex, safeEqual } from '../../common/crypto';

export interface PresignedUpload {
  method: 'POST';
  url: string;
  fields: Record<string, string>;
  maxBytes: number;
}

/**
 * Object storage for invoice photos and PDFs. Uploads go straight from the phone to storage with a
 * short-lived presigned POST, so the API never streams large files. 'local' emulates that for development.
 */
@Injectable()
export class StorageService {
  private readonly s3?: S3Client;

  constructor(private readonly cfg: AppConfig) {
    if (cfg.env.STORAGE_DRIVER === 's3') {
      this.s3 = new S3Client({
        region: cfg.env.S3_REGION,
        endpoint: cfg.env.S3_ENDPOINT,
        forcePathStyle: !!cfg.env.S3_ENDPOINT,
        credentials:
          cfg.env.S3_ACCESS_KEY_ID && cfg.env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: cfg.env.S3_ACCESS_KEY_ID, secretAccessKey: cfg.env.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
    }
  }

  private get bucket(): string {
    if (!this.cfg.env.S3_BUCKET) throw new Error('S3_BUCKET is not set');
    return this.cfg.env.S3_BUCKET;
  }

  private localPath(key: string): string {
    const root = resolve(this.cfg.env.STORAGE_LOCAL_DIR);
    const p = resolve(root, key);
    if (!p.startsWith(root)) throw new Error('Invalid storage key');
    return p;
  }

  localUploadSignature(key: string, expires: number, maxBytes: number, mime: string): string {
    return hmacHex(this.cfg.env.JWT_SECRET, `upload|${key}|${expires}|${maxBytes}|${mime}`);
  }

  verifyLocalUpload(fields: Record<string, string>): boolean {
    const expires = Number(fields.expires);
    if (!fields.key || !fields.signature || !Number.isFinite(expires) || expires < Date.now()) return false;
    const expected = this.localUploadSignature(fields.key, expires, Number(fields.maxBytes), fields['Content-Type'] ?? '');
    return safeEqual(expected, fields.signature);
  }

  async presignUpload(key: string, mime: string, maxBytes: number): Promise<PresignedUpload> {
    if (this.s3) {
      const { url, fields } = await createPresignedPost(this.s3, {
        Bucket: this.bucket,
        Key: key,
        Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', mime]],
        Fields: { 'Content-Type': mime },
        Expires: 600,
      });
      return { method: 'POST', url, fields, maxBytes };
    }
    const expires = Date.now() + 600_000;
    return {
      method: 'POST',
      url: `${this.cfg.env.PUBLIC_BASE_URL}/dev/uploads`,
      fields: {
        key,
        'Content-Type': mime,
        expires: String(expires),
        maxBytes: String(maxBytes),
        signature: this.localUploadSignature(key, expires, maxBytes, mime),
      },
      maxBytes,
    };
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mime }));
      return;
    }
    const p = this.localPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async get(key: string): Promise<Buffer> {
    if (this.s3) {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await out.Body?.transformToByteArray();
      if (!bytes) throw new Error(`Empty object ${key}`);
      return Buffer.from(bytes);
    }
    return readFile(this.localPath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      if (this.s3) {
        await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      } else {
        await stat(this.localPath(key));
      }
      return true;
    } catch {
      return false;
    }
  }

  async downloadUrl(key: string, ttlSeconds = 300): Promise<string> {
    if (this.s3) {
      return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
    }
    const expires = Date.now() + ttlSeconds * 1000;
    const sig = hmacHex(this.cfg.env.JWT_SECRET, `download|${key}|${expires}`);
    return `${this.cfg.env.PUBLIC_BASE_URL}/dev/files?key=${encodeURIComponent(key)}&expires=${expires}&signature=${sig}`;
  }

  verifyLocalDownload(key: string, expires: number, signature: string): boolean {
    return expires > Date.now() && safeEqual(hmacHex(this.cfg.env.JWT_SECRET, `download|${key}|${expires}`), signature);
  }
}
