import { CATEGORY_LABELS, type ExtractedInvoice, formatRs, PURCHASE_CATEGORY_KEYS, type PurchaseCategoryKey } from '@vat-assist/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useSession } from '@/session';
import { Button, Card, Chips, Err, H1, P, Screen } from '@/ui';

interface Doc { id: string; status: string; flags: string[]; extraction: ExtractedInvoice | null }
type Method = 'cash' | 'bank' | 'juice' | 'card';

/** The only two questions an owner answers about a bill: paid now or later, and what it is for. */
export default function DocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, orgId, t, locale } = useSession();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [when, setWhen] = useState<'now' | 'later' | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [category, setCategory] = useState<PurchaseCategoryKey | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async (n: number) => {
      const d = await api<Doc>(`/orgs/${orgId}/documents/${id}`);
      if (!alive) return;
      setDoc(d);
      if (['uploading', 'processing'].includes(d.status) && n < 40) setTimeout(() => poll(n + 1), 1500);
    };
    poll(0).catch((e: Error) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [api, orgId, id]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ outcome: string }>(`/orgs/${orgId}/documents/${id}/answers`, {
        body: { settlement: when === 'now' ? { mode: 'cash', method } : { mode: 'credit' }, category },
      });
      setResult(r.outcome === 'posted' ? t('doc.posted') : t('doc.sentToReview'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!doc || ['uploading', 'processing'].includes(doc.status)) return <Screen><P>{t('capture.checking')}</P><Err>{error}</Err></Screen>;
  if (doc.status === 'rejected_quality') return <Screen><P>{t('capture.blurred')}</P><Button title={t('common.retry')} onPress={() => router.replace('/capture')} /></Screen>;
  if (doc.status === 'duplicate') return <Screen><P>{t('capture.duplicate')}</P><Button title={t('common.continue')} onPress={() => router.replace('/home')} /></Screen>;
  if (result) return <Screen><H1>{result}</H1><Button title={t('common.continue')} onPress={() => router.replace('/home')} /></Screen>;

  const x = doc.extraction;
  return (
    <Screen>
      {x && (
        <Card>
          <P>{x.supplierName.value ?? '?'} {x.invoiceNumber.value ?? ''}</P>
          <P muted>{x.invoiceDate.value ?? ''}  {x.totalCents.value !== null ? formatRs(x.totalCents.value, locale) : ''}</P>
        </Card>
      )}
      {doc.status === 'awaiting_owner' ? (
        <>
          <P>{t('doc.paidWhen')}</P>
          <Chips value={when} onChange={setWhen} options={[{ value: 'now', label: t('doc.paidNow') }, { value: 'later', label: t('doc.paidLater') }]} />
          {when === 'now' && (
            <Chips value={method} onChange={setMethod} options={(['cash', 'bank', 'juice', 'card'] as const).map((m) => ({ value: m, label: t(`doc.method.${m}`) }))} />
          )}
          <P>{t('doc.whatFor')}</P>
          <Chips value={category} onChange={setCategory} options={PURCHASE_CATEGORY_KEYS.map((k) => ({ value: k, label: CATEGORY_LABELS[locale][k] }))} />
          <Err>{error}</Err>
          <Button title={t('common.save')} onPress={submit} busy={busy} disabled={!when || (when === 'now' && !method) || !category} />
        </>
      ) : (
        <P>{t('doc.sentToReview')}</P>
      )}
    </Screen>
  );
}
