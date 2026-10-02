import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useSession } from '@/session';
import { Button, Chips, Err, Field, H1, P, Screen } from '@/ui';

interface Settings { juiceMobile: string | null; juiceName: string | null; bankName: string | null; bankAccountName: string | null; bankAccountNumber: string | null; bankIban: string | null; cardProvider: 'mips' | 'stripe' | null }

/** What customers see on the pay link: the Juice number, the bank account, and whether cards are accepted. */
export default function PaymentSettings() {
  const { api, orgId } = useSession();
  const [v, setV] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Settings>(`/orgs/${orgId}/payment-settings`).then(setV).catch((e: Error) => setError(e.message));
  }, [api, orgId]);
  if (!v) return <Screen><Err>{error}</Err></Screen>;
  const set = (k: keyof Settings) => (text: string) => setV({ ...v, [k]: text.trim() ? text : null });

  async function save() {
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/orgs/${orgId}/payment-settings`, { method: 'PUT', body: v });
      router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <H1>Payment details</H1>
      <Field label="Juice mobile number (+2305…)" value={v.juiceMobile ?? ''} onChangeText={set('juiceMobile')} keyboardType="phone-pad" />
      <Field label="Name on the Juice account" value={v.juiceName ?? ''} onChangeText={set('juiceName')} />
      <Field label="Bank" value={v.bankName ?? ''} onChangeText={set('bankName')} />
      <Field label="Account name" value={v.bankAccountName ?? ''} onChangeText={set('bankAccountName')} />
      <Field label="Account number" value={v.bankAccountNumber ?? ''} onChangeText={set('bankAccountNumber')} keyboardType="number-pad" />
      <Field label="IBAN (MU…)" value={v.bankIban ?? ''} onChangeText={set('bankIban')} autoCapitalize="characters" />
      <P muted>Card payments (needs a merchant account)</P>
      <Chips value={v.cardProvider ?? 'none'} onChange={(c) => setV({ ...v, cardProvider: c === 'none' ? null : c })}
        options={[{ value: 'none', label: 'No cards' }, { value: 'mips', label: 'MIPS' }, { value: 'stripe', label: 'Stripe' }]} />
      <Err>{error}</Err>
      <Button title="Save" onPress={save} busy={busy} />
    </Screen>
  );
}
