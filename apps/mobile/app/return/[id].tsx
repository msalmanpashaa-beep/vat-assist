import { formatRs, type GuideStep } from '@vat-assist/shared';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/session';
import { Button, Card, Err, Field, H1, H2, P, Screen } from '@/ui';
import { byteSize, prepareImage, sendToStorage, type UploadResult } from '@/upload';

interface Guide { returnId: string; status: string; periodLabel: string; steps: GuideStep[] }

/** Guided filing on MRA e-Services, then the acknowledgement and the payment. */
export default function ReturnScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, orgId, t, locale } = useSession();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [ref, setRef] = useState('');
  const [payRef, setPayRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<Guide>(`/orgs/${orgId}/returns/${id}/guide`).then(setGuide).catch((e: Error) => setError(e.message));
  }, [api, orgId, id]);
  useEffect(load, [load]);

  async function attach() {
    setBusy(true);
    setError(null);
    try {
      const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
      const a = r.canceled ? undefined : r.assets[0];
      if (!a) return;
      const file = await prepareImage(a.uri, a.width, a.height);
      const u = await api<UploadResult>(`/orgs/${orgId}/documents/upload-url`, {
        body: { mimeType: file.mimeType, byteSize: await byteSize(file.uri), source: 'camera', kind: 'mra_acknowledgement', originalFilename: file.name },
      });
      await sendToStorage(u.upload, file);
      await api(`/orgs/${orgId}/documents/${u.documentId}/complete`, { method: 'POST' });
      await api(`/orgs/${orgId}/returns/${id}/acknowledgement`, { body: { mraReference: ref.trim(), documentId: u.documentId } });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function paid() {
    setBusy(true);
    setError(null);
    try {
      await api(`/orgs/${orgId}/returns/${id}/payment`, { body: { paymentReference: payRef.trim(), paidOn: new Date().toISOString().slice(0, 10) } });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!guide) return <Screen><Err>{error}</Err></Screen>;
  return (
    <Screen>
      <H1>{guide.periodLabel}</H1>
      {guide.steps.map((s, i) => (
        <Card key={s.key}>
          <P>{i + 1}. {s.title}{s.amountCents !== undefined ? `: ${formatRs(s.amountCents, locale)}` : ''}</P>
          {s.detail ? <P muted>{s.detail}</P> : null}
        </Card>
      ))}
      <Err>{error}</Err>
      {guide.status === 'signed_off' && (
        <>
          <H2>{t('returns.attachAck')}</H2>
          <Field label={t('returns.mraReference')} value={ref} onChangeText={setRef} autoCapitalize="characters" />
          <Button title={t('capture.takePhoto')} onPress={attach} busy={busy} disabled={ref.trim().length < 3} />
        </>
      )}
      {guide.status === 'filed' && (
        <>
          <H2>{t('returns.filed')}</H2>
          <Field label={t('returns.paymentReference')} value={payRef} onChangeText={setPayRef} />
          <Button title={t('returns.recordPayment')} onPress={paid} busy={busy} disabled={payRef.trim().length < 3} />
        </>
      )}
    </Screen>
  );
}
