import { buildOpeningBalances, emptyOpeningForm, formatRs, type OpeningForm } from '@vat-assist/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useSession } from '@/session';
import { Button, Card, Err, Field, H2, P, Screen } from '@/ui';

interface Summary { recorded: boolean; startDate: string; openItems: Array<{ id: string; name: string | null; gross_cents: number; side: string }>; accounts: Array<{ name: string; net_cents: number }> }
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Onboarding step 2: what the business had on its start date. Blank means unknown; the reviewer checks it. */
export default function OpeningBalances() {
  const { first } = useLocalSearchParams<{ first?: string }>();
  const { api, orgId, t, locale } = useSession();
  const [f, setF] = useState<OpeningForm>(emptyOpeningForm());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (orgId) api<Summary>(`/orgs/${orgId}/opening-balances`).then(setSummary).catch((e: Error) => setErrors([e.message]));
  }, [api, orgId]);
  const set = (p: Partial<OpeningForm>) => setF({ ...f, ...p });
  const done = () => router.replace('/home');

  async function save() {
    const r = buildOpeningBalances(f);
    if (!r.ok) return setErrors(r.errors);
    const { totalAssetsCents: _a, totalOwedCents: _o, ...body } = r.value;
    setBusy(true);
    setErrors([]);
    try {
      await api(`/orgs/${orgId}/opening-balances`, { body });
      if (first) done();
      else setSummary(await api<Summary>(`/orgs/${orgId}/opening-balances`));
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  if (summary?.recorded) {
    return (
      <Screen>
        <Stack.Screen options={{ title: t('onb.openingTitle') }} />
        <P>{t('onb.saved')}</P>
        <Card>{summary.accounts.map((a) => <P key={a.name}>{a.name}: {formatRs(Math.abs(a.net_cents), locale)}</P>)}</Card>
        <Card>{summary.openItems.map((i) => <P key={i.id}>{i.name}: {formatRs(i.gross_cents, locale)}</P>)}</Card>
        <Button title={t('common.continue')} onPress={done} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Stack.Screen options={{ title: t('onb.openingTitle') }} />
      <P muted>{t('onb.openingHint', { date: summary ? ddmm(summary.startDate) : '…' })}</P>
      {errors.map((m) => <Err key={m}>{m}</Err>)}
      <Field label={t('onb.cash')} value={f.cash} onChangeText={(v) => set({ cash: v })} keyboardType="decimal-pad" />
      <H2>{t('onb.bank')}</H2>
      {f.banks.map((b, i) => (
        <Card key={`b${i}`}>
          <Field label={t('onb.bankName')} value={b.name} onChangeText={(v) => set({ banks: f.banks.map((x, j) => (j === i ? { ...x, name: v } : x)) })} />
          <Field label="Rs" value={b.amount} onChangeText={(v) => set({ banks: f.banks.map((x, j) => (j === i ? { ...x, amount: v } : x)) })} keyboardType="decimal-pad" />
        </Card>
      ))}
      <Button title={t('onb.addRow')} kind="quiet" onPress={() => set({ banks: [...f.banks, { name: '', amount: '' }] })} />
      <Field label={t('onb.stock')} value={f.stock} onChangeText={(v) => set({ stock: v })} keyboardType="decimal-pad" />
      <H2>{t('onb.customersOwe')}</H2>
      {f.customers.map((c, i) => (
        <Card key={`c${i}`}>
          <Field label={t('inv.customer')} value={c.name} onChangeText={(v) => set({ customers: f.customers.map((x, j) => (j === i ? { ...x, name: v } : x)) })} />
          <Field label="Rs" value={c.amount} onChangeText={(v) => set({ customers: f.customers.map((x, j) => (j === i ? { ...x, amount: v } : x)) })} keyboardType="decimal-pad" />
          <Field label={t('inv.phone')} value={c.phone ?? ''} onChangeText={(v) => set({ customers: f.customers.map((x, j) => (j === i ? { ...x, phone: v } : x)) })} keyboardType="phone-pad" />
        </Card>
      ))}
      <Button title={t('onb.addRow')} kind="quiet" onPress={() => set({ customers: [...f.customers, { name: '', amount: '', phone: '' }] })} />
      <H2>{t('onb.suppliersOwed')}</H2>
      {f.suppliers.map((c, i) => (
        <Card key={`s${i}`}>
          <Field label={t('pay.who')} value={c.name} onChangeText={(v) => set({ suppliers: f.suppliers.map((x, j) => (j === i ? { ...x, name: v } : x)) })} />
          <Field label="Rs" value={c.amount} onChangeText={(v) => set({ suppliers: f.suppliers.map((x, j) => (j === i ? { ...x, amount: v } : x)) })} keyboardType="decimal-pad" />
        </Card>
      ))}
      <Button title={t('onb.addRow')} kind="quiet" onPress={() => set({ suppliers: [...f.suppliers, { name: '', amount: '' }] })} />
      <Field label={t('onb.vatCredit')} value={f.vatCredit} onChangeText={(v) => set({ vatCredit: v })} keyboardType="decimal-pad" />
      <Button title={t('common.save')} onPress={save} busy={busy} />
      {first ? <Button title={t('onb.skip')} kind="quiet" onPress={done} /> : null}
    </Screen>
  );
}
