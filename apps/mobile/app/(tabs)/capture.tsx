import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { useSession } from '@/session';
import { Button, Err, H1, P, Screen } from '@/ui';
import { byteSize, type Picked, prepareImage, sendToStorage, type UploadResult } from '@/upload';

/** Photo, gallery or PDF → presigned upload → the server checks quality and duplicates, then reads it. */
export default function Capture() {
  const { api, orgId, t } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(file: Picked, source: 'camera' | 'gallery' | 'pdf') {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    try {
      const u = await api<UploadResult>(`/orgs/${orgId}/documents/upload-url`, {
        body: { mimeType: file.mimeType, byteSize: await byteSize(file.uri), source, kind: 'purchase_invoice', originalFilename: file.name },
      });
      await sendToStorage(u.upload, file);
      await api(`/orgs/${orgId}/documents/${u.documentId}/complete`, { method: 'POST' });
      router.push(`/document/${u.documentId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function camera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setError('Allow the camera in your phone settings to photograph invoices.');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
    const a = r.canceled ? undefined : r.assets[0];
    if (a) await send(await prepareImage(a.uri, a.width, a.height), 'camera');
  }

  async function gallery() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    const a = r.canceled ? undefined : r.assets[0];
    if (a) await send(await prepareImage(a.uri, a.width, a.height), 'gallery');
  }

  async function pdf() {
    const r = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
    const a = r.canceled ? undefined : r.assets[0];
    if (a) await send({ uri: a.uri, mimeType: 'application/pdf', name: a.name }, 'pdf');
  }

  return (
    <Screen>
      <H1>{t('home.snap')}</H1>
      <P muted>Flat on a table, in good light, the whole page in the frame.</P>
      <Button title={t('capture.takePhoto')} onPress={camera} busy={busy} />
      <Button title={t('capture.choosePhoto')} kind="quiet" onPress={gallery} disabled={busy} />
      <Button title={t('capture.choosePdf')} kind="quiet" onPress={pdf} disabled={busy} />
      {busy && <P muted>{t('capture.checking')}</P>}
      <Err>{error}</Err>
    </Screen>
  );
}
