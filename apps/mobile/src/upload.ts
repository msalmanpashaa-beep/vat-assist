import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export interface Picked { uri: string; mimeType: 'image/jpeg' | 'application/pdf'; name: string }

/** Photos are straightened to 2000 px on the long side and re-encoded as JPEG: sharp enough to read, small enough for 3G. */
export async function prepareImage(uri: string, width: number, height: number): Promise<Picked> {
  const ctx = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > 2000) ctx.resize(width >= height ? { width: 2000 } : { height: 2000 });
  const image = await ctx.renderAsync();
  const out = await image.saveAsync({ compress: 0.82, format: SaveFormat.JPEG });
  return { uri: out.uri, mimeType: 'image/jpeg', name: `photo-${Date.now()}.jpg` };
}

export async function byteSize(uri: string): Promise<number> {
  return (await (await fetch(uri)).blob()).size;
}

/** Sends the file straight to storage with the presigned POST the API returned. */
export async function sendToStorage(upload: { url: string; fields: Record<string, string> }, file: Picked): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append('file', { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  const res = await fetch(upload.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

export interface UploadResult { documentId: string; upload: { url: string; fields: Record<string, string> } }
