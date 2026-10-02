import { type AgeingReport, autoAllocate, buildPayment, formatRs, parseRupees } from '@vat-assist/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/session';
import { Balances } from '@/Balances';
import { Button, Card, Chips, Err, Field, H2, P, Screen } from '@/ui';

type Method = 'cash' | 'bank' | 'juice' | 'card';

/** One payment against one or more open invoices (full or part). Ledger, ageing and cash/bank update at once. */
export default function RecordPayment() {
  const { side } = useLocalSearchParams<{ side: string }>();
  const kind = side === 'pay' ? 'payment' : 'receipt';
  const { api, orgId, t, locale } = useSession();
  const today = new Date().toISOString().slice(0, 10);
  const [report, setReport] = useState<AgeingReport | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>(kind === 'receipt' ? 'cash' : 'bank');
  const [date, setDate] = useState(today);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<AgeingReport>(`/orgs/${orgId}/ageing?side=${kind === 'receipt' ? 'receivable' : 'payable'}`)
      .then((r) => {
        setReport(r);
        setContactId((c) => c ?? r.contacts.find((x) => x.contactId && x.items.length)?.contactId ?? null);
      })
      .catch((e: Error) => setErrors([e.message]));
  }, [api, orgId, kind]);
  useEffect(load, [load]);
  const who = (report?.contacts ?? []).filter((c) => c.contactId && c.items.length);
  const contact = who.find((c) => c.contactId === contactId);
  const open = (contact?.items ?? []).map((i) => ({ transactionId: i.transactionId, reference: i.reference, issueDate: i.issueDate, outstandingCents: i.outstandingCents }));

  async function save() {
    const r = buildPayment({ kind, contactId: contactId ?? '', date, method, amount, allocations: alloc }, open);
    if (!r.ok) return setErrors(r.errors);
    const { unallocatedCents: _u, ...body } = r.value;
    setBusy(true);
    setErrors([]);
    try {
      await api(`/orgs/${orgId}/payments`, { body });
      setSaved(t('pay.saved'));
      setAmount('');
      setAlloc({});
      load();
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: kind === 'receipt' ? t('pay.receiveTitle') : t('pay.payTitle') }} />
      {saved && <P>{saved}</P>}
      {errors.map((m) => <Err key={m}>{m}</Err>)}
      <Balances />
      {who.length === 0 ? <P muted>{report ? 'Nothing is owed right now.' : '…'}</P> : (
        <>
          <P>{t('pay.who')}</P>
          <Chips value={contactId} onChange={(v) => { setContactId(v); setAlloc({}); }} options={who.map((c) => ({ value: c.contactId as string, label: `${c.contactName} ${formatRs(c.total, locale)}` }))} />
          <Field label={t('pay.amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          <Chips value={method} onChange={setMethod} options={(['cash', 'bank', 'juice', 'card'] as const).map((m) => ({ value: m, label: t(`doc.method.${m}`) }))} />
          <Field label={t('pay.date')} value={date} onChangeText={setDate} />
          <H2>{t('pay.allocate')}</H2>
          {open.map((i) => (
            <Card key={i.transactionId}>
              <P>{i.reference ?? t('onb.openingTitle')} · {i.issueDate} · {formatRs(i.outstandingCents, locale)}</P>
              <Field label={t('pay.amount')} value={alloc[i.transactionId] ?? ''} onChangeText={(v) => setAlloc({ ...alloc, [i.transactionId]: v })} keyboardType="decimal-pad" />
            </Card>
          ))}
          <Button title="Oldest first" kind="quiet" onPress={() => setAlloc(Object.fromEntries(autoAllocate(Math.max(0, parseRupees(amount) || 0), open).map((a) => [a.invoiceId, (a.amountCents / 100).toFixed(2)])))} />
          <Button title={t('common.save')} onPress={save} busy={busy} />
        </>
      )}
    </Screen>
  );
}
