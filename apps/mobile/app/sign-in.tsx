import type { Locale, SessionTokens } from '@vat-assist/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { API_URL, useSession } from '@/session';
import { Button, Chips, Err, Field, H1, P, Screen } from '@/ui';

export default function SignIn() {
  const { signIn, t, locale: deviceLocale } = useSession();
  const [locale, setLocale] = useState<Locale>(deviceLocale);
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(path: string, body: unknown) {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new Error(data.message ?? 'Error');
    return data;
  }

  async function go() {
    setBusy(true);
    setError(null);
    try {
      if (!sent) {
        await post('/auth/otp/start', { phone });
        setSent(true);
      } else {
        await signIn((await post('/auth/otp/verify', { phone, code, locale })) as SessionTokens);
        router.replace('/');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <H1>VAT Assist</H1>
      <Chips value={locale} onChange={setLocale} options={[{ value: 'mfe', label: 'Kreol' }, { value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }]} />
      {!sent ? (
        <>
          <Field label={t('auth.phoneTitle')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="5712 3456" />
          <P muted>{t('auth.phoneHint')}</P>
        </>
      ) : (
        <Field label={t('auth.codeTitle')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} />
      )}
      <Err>{error}</Err>
      <Button title={sent ? t('auth.verify') : t('auth.sendCode')} onPress={go} busy={busy} />
    </Screen>
  );
}
