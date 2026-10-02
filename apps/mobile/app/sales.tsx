import { router } from 'expo-router';
import { useState } from 'react';
import { useSession } from '@/session';
import { Button, Err, Field, H1, P, Screen } from '@/ui';

const cents = (s: string) => Math.round(Number(s.replace(/[\s,]/g, '')) * 100);

/** End-of-day takings from the till: totals including VAT, split by how customers paid. */
export default function Sales() {
  const { api, orgId, t } = useSession();
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({ cash: '', juice: '', card: '', zero: '', exempt: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (text: string) => setV({ ...v, [k]: text });

  async function save() {
    const lines = [
      { method: 'cash', vatCode: 'SR', grossCents: cents(v.cash) },
      { method: 'juice', vatCode: 'SR', grossCents: cents(v.juice) },
      { method: 'card', vatCode: 'SR', grossCents: cents(v.card) },
      { method: 'cash', vatCode: 'ZR', grossCents: cents(v.zero) },
      { method: 'cash', vatCode: 'EX', grossCents: cents(v.exempt) },
    ].filter((l) => Number.isFinite(l.grossCents) && l.grossCents > 0);
    if (!lines.length) return setError('Enter at least one amount.');
    setBusy(true);
    setError(null);
    try {
      await api(`/orgs/${orgId}/daily-takings`, { body: { date: today, lines } });
      router.replace('/home');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <H1>{t('sales.title')}</H1>
      <P muted>{t('sales.hint')}</P>
      <P>{t('sales.standard')}</P>
      <Field label={t('doc.method.cash')} value={v.cash} onChangeText={set('cash')} keyboardType="decimal-pad" />
      <Field label={t('doc.method.juice')} value={v.juice} onChangeText={set('juice')} keyboardType="decimal-pad" />
      <Field label={t('doc.method.card')} value={v.card} onChangeText={set('card')} keyboardType="decimal-pad" />
      <Field label={t('sales.zero')} value={v.zero} onChangeText={set('zero')} keyboardType="decimal-pad" />
      <Field label={t('sales.exempt')} value={v.exempt} onChangeText={set('exempt')} keyboardType="decimal-pad" />
      <Err>{error}</Err>
      <Button title={t('common.save')} onPress={save} busy={busy} />
    </Screen>
  );
}
