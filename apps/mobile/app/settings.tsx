import { WHATSAPP_CONSENT } from '@vat-assist/shared';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Switch, View } from 'react-native';
import { useFeatures } from '@/features';
import { useSession } from '@/session';
import { C } from '@/theme';
import { Card, Err, P, Screen } from '@/ui';

interface Settings { debtorRemindersEnabled: boolean; scheduledInvoiceReminders: number; whatsappOptIn: boolean }

export default function SettingsScreen() {
  const { api, orgId, t } = useSession();
  const features = useFeatures();
  const [s, setS] = useState<Settings | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (orgId) api<Settings>(`/orgs/${orgId}/settings`).then(setS).catch((e: Error) => setError(e.message));
  }, [api, orgId]);
  useFocusEffect(load);

  async function reminders(on: boolean) {
    setError(null);
    try {
      const r = await api<Settings & { scheduled: number; cancelled: number }>(`/orgs/${orgId}/settings`, { method: 'PATCH', body: { debtorRemindersEnabled: on } });
      setS(r);
      setNote(t('set.scheduled', { count: r.scheduledInvoiceReminders }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function whatsapp(on: boolean) {
    if (on) return router.push('/whatsapp-consent');
    try {
      await api(`/orgs/${orgId}/whatsapp-consent`, { body: { optIn: false, consentVersion: WHATSAPP_CONSENT.version } });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: t('set.title') }} />
      <Err>{error}</Err>
      {s && features.invoice_reminders && (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Switch value={s.debtorRemindersEnabled} onValueChange={reminders} trackColor={{ true: C.ink }} accessibilityLabel={t('set.invoiceReminders')} />
            <View style={{ flex: 1 }}><P>{t('set.invoiceReminders')}</P></View>
          </View>
          <P muted>{note ?? t('set.scheduled', { count: s.scheduledInvoiceReminders })}</P>
        </Card>
      )}
      {s && features.whatsapp_opt_in && (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Switch value={s.whatsappOptIn} onValueChange={whatsapp} trackColor={{ true: C.ink }} accessibilityLabel={t('set.whatsapp')} />
            <View style={{ flex: 1 }}><P>{t('set.whatsapp')}</P></View>
          </View>
        </Card>
      )}
    </Screen>
  );
}
