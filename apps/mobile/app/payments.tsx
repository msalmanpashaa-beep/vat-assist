import { formatRs } from '@vat-assist/shared';
import { Linking } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useSession } from '@/session';
import { Button, Card, Err, H1, P, Screen } from '@/ui';

interface Incoming { id: string; provider: string; amount_cents: number; payer_name: string | null; payer_reference: string | null; received_on: string | null; reference: string | null; proofUrl: string | null }

/** Customers who say they paid by Juice or bank transfer. Confirm only after checking the account. */
export default function Payments() {
  const { api, orgId, locale } = useSession();
  const [items, setItems] = useState<Incoming[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Incoming[]>(`/orgs/${orgId}/incoming-payments?status=awaiting_confirmation`).then(setItems).catch((e: Error) => setError(e.message));
  }, [api, orgId]);
  useFocusEffect(load);

  async function act(id: string, action: 'confirm' | 'reject', received: string | null) {
    try {
      await api(`/orgs/${orgId}/incoming-payments/${id}/${action}`, {
        body: action === 'confirm' ? { receivedOn: received ?? new Date().toISOString().slice(0, 10) } : { reason: 'The money did not arrive' },
      });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Screen>
      <H1>Payments to confirm</H1>
      <P muted>Open your Juice or bank app first. Confirm only what you can see.</P>
      <Err>{error}</Err>
      {items.length === 0 && <P>Nothing waiting.</P>}
      {items.map((p) => (
        <Card key={p.id}>
          <P>{p.payer_name ?? 'Customer'}: {formatRs(p.amount_cents, locale)} by {p.provider === 'juice' ? 'Juice' : 'bank transfer'}</P>
          <P muted>Reference {p.reference}{p.payer_reference ? `, their ref ${p.payer_reference}` : ''}{p.received_on ? `, sent ${p.received_on}` : ''}</P>
          {p.proofUrl && <Button title="See their screenshot" kind="quiet" onPress={() => Linking.openURL(p.proofUrl as string)} />}
          <Button title="Money received" onPress={() => act(p.id, 'confirm', p.received_on)} />
          <Button title="Not received" kind="quiet" onPress={() => act(p.id, 'reject', null)} />
        </Card>
      ))}
    </Screen>
  );
}
