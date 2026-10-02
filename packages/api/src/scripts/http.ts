/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from 'otplib';
import sharp from 'sharp';

/** Small HTTP helpers shared by the demo-data script and the end-to-end tests. */
export const API = process.env.E2E_API_URL ?? process.env.DEMO_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
export const OTP = process.env.OTP_DEV_FIXED_CODE ?? '000000';

export async function call(method: string, path: string, o: { token?: string; body?: unknown; expect?: number[]; headers?: Record<string, string> } = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  if (!(o.expect ?? [200, 201, 202, 204]).includes(res.status)) throw new Error(`${method} ${path} returned ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function ownerLogin(phone: string, locale = 'en'): Promise<string> {
  await call('POST', '/auth/otp/start', { body: { phone } });
  return (await call('POST', '/auth/otp/verify', { body: { phone, code: OTP, locale } })).accessToken;
}

export interface StaffCred { email: string; password: string; role: string; userId: string; totpSecret: string }

export function staffCredentials(): { platformOrgId: string; staff: StaffCred[] } {
  const file = process.env.E2E_STAFF_CREDENTIALS ?? join(process.cwd(), 'demo-output', 'staff-credentials.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function staffLogin(email: string, password: string, secret: string): Promise<string> {
  const l = await call('POST', '/auth/staff/login', { body: { email, password } });
  return (await call('POST', '/auth/staff/totp/verify', { body: { code: await generate({ secret }) }, headers: { authorization: `Bearer ${l.mfaToken}` } })).accessToken;
}

/** A synthetic photo of a supplier invoice; the development reader recognises it by file name. */
export async function invoicePhoto(title: string): Promise<Buffer> {
  const rows = Array.from({ length: 20 }, (_, i) => `<line x1="420" x2="1180" y1="${380 + i * 56}" y2="${380 + i * 56}" stroke="#333" stroke-width="3"/>`).join('');
  const block = Array.from({ length: 300 }, (_, i) => ((i + Math.floor(i / 15)) % 2 ? '' : `<rect x="${120 + (i % 15) * 16}" y="${1300 + Math.floor(i / 15) * 16}" width="16" height="16" fill="#000"/>`)).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="1240" height="1754" fill="#fdfdf8"/><rect x="0" y="0" width="360" height="1754" fill="#2a2a2a"/>${rows}${block}<text x="440" y="300" font-size="40">${title}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer();
}

export async function snap(token: string, orgId: string, name: string, bytes: Buffer): Promise<any> {
  const u = await call('POST', `/orgs/${orgId}/documents/upload-url`, { token, body: { mimeType: 'image/jpeg', byteSize: bytes.length, source: 'camera', kind: 'purchase_invoice', originalFilename: name } });
  const form = new FormData();
  for (const [k, v] of Object.entries(u.upload.fields as Record<string, string>)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), name);
  const put = await fetch(u.upload.url, { method: 'POST', body: form });
  if (put.status >= 300) throw new Error(`upload failed ${put.status}`);
  let doc = await call('POST', `/orgs/${orgId}/documents/${u.documentId}/complete`, { token });
  for (let i = 0; i < 40 && ['uploading', 'processing'].includes(doc.status); i++) {
    await new Promise((r) => setTimeout(r, 250));
    doc = await call('GET', `/orgs/${orgId}/documents/${u.documentId}`, { token });
  }
  return doc;
}
