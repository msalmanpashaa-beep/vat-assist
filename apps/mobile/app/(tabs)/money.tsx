import { formatRs } from '@vat-assist/shared';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Share, Text, View } from 'react-native';
import { useSession } from '@/session';
import { C, F } from '@/theme';
import { Button, Card, Chips, Err, H1, H2, P, Screen } from '@/ui';

interface Ageing { total: number; buckets: Record<string, number> }
interface Invoice { id: string; reference: string | null; contact_name: string | null; gross_cents: number; issue_date: string; settlement: string | null }

const BUCKETS = ['0-30', '31-60', '61-90', '90+'];

/** Who owes me, whom I owe, and a pay link to send for any sales invoice. */
export default function Money() {
  const { api, orgId, t, locale } = useSession();
  const [side, setSide] = useState<'receivable' | 'payable'>('receivable');
  const [ageing, setAgeing] = useState<Ageing | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    if (!orgId) return;
    api<Ageing>(`/orgs/${orgId}/ageing?side=${side}`).then(setAgeing).catch((e: Error) => setError(e.message));
    api<Invoice[]>(`/orgs/${orgId}/transactions?kind=sales_invoice&status=posted`)
      .then((rows) => setInvoices(rows.filter((r) => r.settlement === 'credit').slice(0, 20)))
      .catch(() => undefined);
  }, [api, orgId, side]));

  async function payLink(inv: Invoice) {
    setError(null);
    try {
      const r = await api<{ payUrl: string; amountCents: number; reference: string }>(`/orgs/${orgId}/payment-requests`, { body: { payableKind: 'invoice', payableId: inv.id } });
      await Share.share({ message: `${inv.reference ?? ''}: ${formatRs(r.amountCents, locale)}. Pay by Juice, bank transfer or card (ref ${r.reference}): ${r.payUrl}` });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Screen>
      <H1>{t('nav.money')}</H1>
      <Chips value={side} onChange={setSide} options={[{ value: 'receivable', label: t('money.owesMe') }, { value: 'payable', label: t('money.iOwe') }]} />
      {ageing && (
        <Card>
          <Text style={{ fontFamily: F.heavy, fontSize: 30, color: C.slate }}>{formatRs(ageing.total, locale)}</Text>
          {BUCKETS.map((b) => (
            <View key={b} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={{ fontFamily: F.regular, fontSize: 16, color: b === '90+' ? C.red : C.slate }}>{b} days</Text>
              <Text style={{ fontFamily: F.bold, fontSize: 16, color: C.slate }}>{formatRs(ageing.buckets[b] ?? 0, locale)}</Text>
            </View>
          ))}
        </Card>
      )}
      <Err>{error}</Err>
      {side === 'receivable' && invoices.length > 0 && (
        <>
          <H2>Send a pay link</H2>
          <P muted>Your customer can pay by Juice, bank transfer or card. You confirm transfers when you see the money.</P>
          {invoices.map((inv) => (
            <Card key={inv.id}>
              <P>{inv.reference} · {inv.contact_name ?? ''} · {formatRs(inv.gross_cents, locale)}</P>
              <Button title="Share pay link" kind="quiet" onPress={() => payLink(inv)} />
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
