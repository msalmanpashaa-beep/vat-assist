import { router } from 'expo-router';
import { useState } from 'react';
import { useSession } from '@/session';
import { Button, Chips, Err, Field, H1, P, Screen } from '@/ui';

/** Step 1 of onboarding. Opening balances (cash, bank, stock, who owes what) are taken with the reviewer on the call. */
export default function Onboarding() {
  const { api, reloadMe, locale } = useSession();
  const [legalName, setLegalName] = useState('');
  const [tradingName, setTradingName] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [frequency, setFrequency] = useState<'quarterly' | 'monthly'>('quarterly');
  const [startDate, setStartDate] = useState(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/orgs', {
        body: {
          legalName, tradingName: tradingName || undefined, legalForm: /\b(ltd|limited|ltée)\b/i.test(legalName) ? 'company' : 'sole_trader',
          vatNumber: vatNumber || undefined, filingFrequency: frequency, startDate, defaultLocale: locale,
        },
      });
      await reloadMe();
      router.replace('/opening-balances?first=1');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <H1>Your business</H1>
      <Field label="Registered name (as on your BRN)" value={legalName} onChangeText={setLegalName} />
      <Field label="Shop name, if different" value={tradingName} onChangeText={setTradingName} />
      <Field label="VAT number (8 digits)" value={vatNumber} onChangeText={setVatNumber} keyboardType="number-pad" maxLength={8} />
      <P muted>How often do you file VAT?</P>
      <Chips value={frequency} onChange={setFrequency} options={[{ value: 'quarterly', label: 'Every 3 months' }, { value: 'monthly', label: 'Every month' }]} />
      <Field label="Start recording from (YYYY-MM-DD)" value={startDate} onChangeText={setStartDate} />
      <Err>{error}</Err>
      <Button title="Continue" onPress={save} busy={busy} disabled={legalName.trim().length < 2} />
    </Screen>
  );
}
