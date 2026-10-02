import { WHATSAPP_CONSENT } from '@vat-assist/shared';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { useSession } from '@/session';
import { Button, Card, Err, P, Screen } from '@/ui';

/** What the owner agrees to before WhatsApp is used. The wording version is stored with the opt-in. */
export default function WhatsAppConsent() {
  const { api, orgId, t, locale } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function agree() {
    setBusy(true);
    try {
      await api(`/orgs/${orgId}/whatsapp-consent`, { body: { optIn: true, consentVersion: WHATSAPP_CONSENT.version } });
      router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: t('wa.title') }} />
      <Card><P>{WHATSAPP_CONSENT.text[locale]}</P></Card>
      <Err>{error}</Err>
      <Button title={t('wa.agree')} onPress={agree} busy={busy} />
      <Button title={t('common.continue')} kind="quiet" onPress={() => router.back()} />
    </Screen>
  );
}
