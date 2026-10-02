import { formatRs, type VatPot } from '@vat-assist/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useFeatures } from '@/features';
import { useSession } from '@/session';
import { C, F } from '@/theme';
import { Button, Err, P, Screen } from '@/ui';

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** The yellow duplicate slip: MRA's share of the money in the till. */
export default function Home() {
  const { api, orgId, t, locale, signOut } = useSession();
  const features = useFeatures();
  const [pot, setPot] = useState<VatPot | null>(null);
  const [questions, setQuestions] = useState(0);
  const [toConfirm, setToConfirm] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    if (!orgId) return;
    Promise.all([
      api<VatPot>(`/orgs/${orgId}/vat-pot`),
      api<Array<{ status: string }>>(`/orgs/${orgId}/queries`),
      api<unknown[]>(`/orgs/${orgId}/incoming-payments?status=awaiting_confirmation`),
    ])
      .then(([p, q, i]) => {
        setPot(p);
        setQuestions(q.filter((x) => x.status === 'open').length);
        setToConfirm(i.length);
      })
      .catch((e: Error) => setError(e.message));
  }, [api, orgId]));

  const credit = !!pot && pot.creditCarriedForwardCents > 0;
  return (
    <Screen>
      {pot && (
        <View style={{ backgroundColor: C.slip, padding: 20, borderRadius: 3, marginBottom: 16 }} accessible accessibilityLabel={`${t('home.potTitle')} ${formatRs(pot.setAsideCents, locale)}`}>
          <Text style={{ fontFamily: F.regular, fontSize: 16, color: C.slate }}>{credit ? pot.periodLabel : `${t('home.potTitle')}, ${pot.periodLabel}`}</Text>
          <Text style={{ fontFamily: F.heavy, fontSize: 40, color: C.slate, marginVertical: 4 }}>{formatRs(credit ? pot.creditCarriedForwardCents : pot.setAsideCents, locale)}</Text>
          {credit && <Text style={{ fontFamily: F.regular, fontSize: 16, color: C.slate }}>{t('home.potCredit', { amount: formatRs(pot.creditCarriedForwardCents, locale) })}</Text>}
          {pot.outputVatOnUnpaidSalesCents > 0 && (
            <Text style={{ fontFamily: F.regular, fontSize: 15, color: C.slate }}>{t('home.potUnpaid', { amount: formatRs(pot.outputVatOnUnpaidSalesCents, locale) })}</Text>
          )}
          <Text style={{ fontFamily: F.bold, fontSize: 15, color: C.slate, marginTop: 10 }}>{t('home.potDue', { date: ddmm(pot.dueStandard) })}</Text>
        </View>
      )}
      <Err>{error}</Err>
      <Button title={t('home.snap')} onPress={() => router.push('/capture')} />
      <Button title={t('home.todaySales')} kind="quiet" onPress={() => router.push('/sales')} />
      {features.credit_invoices && <Button title={t('inv.title')} kind="quiet" onPress={() => router.push('/invoice-new')} />}
      {features.record_payments && <Button title={t('pay.receiveTitle')} kind="quiet" onPress={() => router.push('/record-payment?side=receive')} />}
      {features.record_payments && <Button title={t('pay.payTitle')} kind="quiet" onPress={() => router.push('/record-payment?side=pay')} />}
      {toConfirm > 0 && <Button title={`Payments to confirm: ${toConfirm}`} onPress={() => router.push('/payments')} />}
      {questions > 0 && <Button title={t('home.questions', { count: questions })} kind="quiet" onPress={() => router.push('/queries')} />}
      <P muted> </P>
      <Button title="Payment details" kind="quiet" onPress={() => router.push('/payment-settings')} />
      <Button title={t('set.title')} kind="quiet" onPress={() => router.push('/settings')} />
      {features.opening_balances && <Button title={t('onb.openingTitle')} kind="quiet" onPress={() => router.push('/opening-balances')} />}
      <Button title={t('common.signOut')} kind="quiet" onPress={() => signOut().then(() => router.replace('/sign-in'))} />
    </Screen>
  );
}
