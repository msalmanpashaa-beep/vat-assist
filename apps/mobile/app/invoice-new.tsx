import { addDaysIso, buildSalesInvoice, formatRs, invoiceTotals, parseRupees, type VatCodeChoice } from '@vat-assist/shared';
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { useSession } from '@/session';
import { C } from '@/theme';
import { Button, Card, Chips, Err, Field, H2, P, Screen } from '@/ui';

interface Customer { id: string; kind: string; name: string; phone_e164: string | null; reminder_consent: boolean }
type Line = { description: string; amount: string; vatCode: VatCodeChoice };
const blank = (): Line => ({ description: '', amount: '', vatCode: 'SR' });

/** A sale on credit: who, what, when it is due. Recorded at once, so it shows in "who owes me" today. */
export default function NewInvoice() {
  const { api, orgId, t, locale } = useSession();
  const today = new Date().toISOString().slice(0, 10);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string>('new');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDaysIso(today, 30));
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Customer[]>(`/orgs/${orgId}/contacts`).then((c) => setCustomers(c.filter((x) => x.kind !== 'supplier'))).catch(() => undefined);
  }, [api, orgId]);
  const totals = invoiceTotals(lines.map((l) => ({ netCents: Math.max(0, parseRupees(l.amount) || 0), vatCode: l.vatCode })));
  const setLine = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));

  async function save() {
    const r = buildSalesInvoice({
      ...(customerId === 'new' ? { customerName: name } : { customerId }),
      customerPhone: phone || undefined, reminderConsent: consent, issueDate, dueDate, lines,
    });
    if (!r.ok) return setErrors(r.errors);
    const { totals: _t, ...body } = r.value;
    setBusy(true);
    setErrors([]);
    try {
      const inv = await api<{ reference: string; grossCents: number; dueDate: string }>(`/orgs/${orgId}/sales-invoices`, { body });
      setSaved(t('inv.saved', { number: inv.reference, amount: formatRs(inv.grossCents, locale), date: inv.dueDate }));
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <Screen>
        <Stack.Screen options={{ title: t('inv.title') }} />
        <P>{saved}</P>
        <Button title={t('common.continue')} onPress={() => router.replace('/home')} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Stack.Screen options={{ title: t('inv.title') }} />
      {errors.map((m) => <Err key={m}>{m}</Err>)}
      <P>{t('inv.customer')}</P>
      <Chips value={customerId} onChange={setCustomerId} options={[...customers.slice(0, 8).map((c) => ({ value: c.id, label: c.name })), { value: 'new', label: t('inv.newCustomer') }]} />
      {customerId === 'new' && <Field label={t('inv.customer')} value={name} onChangeText={setName} />}
      <Field label={t('inv.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="5712 3456" />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Switch value={consent} onValueChange={setConsent} trackColor={{ true: C.ink }} accessibilityLabel={t('inv.consent')} />
        <P>{t('inv.consent')}</P>
      </View>
      <Field label={t('inv.issue')} value={issueDate} onChangeText={setIssueDate} />
      <Field label={t('inv.due')} value={dueDate} onChangeText={setDueDate} />
      {lines.map((l, i) => (
        <Card key={i}>
          <Field label={t('inv.line')} value={l.description} onChangeText={(v) => setLine(i, { description: v })} />
          <Field label={t('inv.amount')} value={l.amount} onChangeText={(v) => setLine(i, { amount: v })} keyboardType="decimal-pad" />
          <Chips value={l.vatCode} onChange={(v) => setLine(i, { vatCode: v })} options={[{ value: 'SR', label: 'VAT 15%' }, { value: 'ZR', label: '0%' }, { value: 'EX', label: 'Exempt' }]} />
        </Card>
      ))}
      <Button title={t('inv.addLine')} kind="quiet" onPress={() => setLines([...lines, blank()])} />
      <H2>{t('inv.total', { amount: formatRs(totals.grossCents, locale), vat: formatRs(totals.vatCents, locale) })}</H2>
      <Button title={t('common.save')} onPress={save} busy={busy} />
    </Screen>
  );
}
