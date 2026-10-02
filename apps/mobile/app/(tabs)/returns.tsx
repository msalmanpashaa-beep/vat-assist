import { formatRs } from '@vat-assist/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useSession } from '@/session';
import { Button, Card, Err, H1, P, Screen } from '@/ui';

interface Period { id: string; starts_on: string; ends_on: string; status: string; due_on: string; extended_due_on: string; return_id: string | null; return_status: string | null; net_payable_cents: number | null }
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const STAGE: Record<string, string> = { open: 'Open', in_review: 'Being checked', signed_off: 'Ready to file', filed: 'Filed', paid: 'Paid', closed: 'Closed' };

export default function Returns() {
  const { api, orgId, t, locale } = useSession();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (orgId) api<Period[]>(`/orgs/${orgId}/periods`).then(setPeriods).catch((e: Error) => setError(e.message));
  }, [api, orgId]);
  useFocusEffect(load);

  async function done(id: string) {
    try {
      await api(`/orgs/${orgId}/periods/${id}/ready`, { method: 'POST' });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Screen>
      <H1>{t('returns.title')}</H1>
      <Err>{error}</Err>
      {periods.map((p) => (
        <Card key={p.id}>
          <P>{ddmm(p.starts_on)} – {ddmm(p.ends_on)}: {STAGE[p.status] ?? p.status}</P>
          <P muted>Due {ddmm(p.due_on)}, or {ddmm(p.extended_due_on)} if you file and pay online{p.net_payable_cents !== null ? `. To pay: ${formatRs(p.net_payable_cents, locale)}` : ''}</P>
          {p.status === 'open' && <Button title={t('returns.done')} onPress={() => done(p.id)} />}
          {p.return_id && ['signed_off', 'filed', 'paid'].includes(p.return_status ?? '') && (
            <Button title={t('returns.guide')} kind="quiet" onPress={() => router.push(`/return/${p.return_id}`)} />
          )}
        </Card>
      ))}
    </Screen>
  );
}
