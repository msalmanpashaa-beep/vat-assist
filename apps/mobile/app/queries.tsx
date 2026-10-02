import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useSession } from '@/session';
import { Button, Card, Err, Field, H1, P, Screen } from '@/ui';

interface Q { id: string; status: string; first_message: string | null; last_message: string | null }

export default function Queries() {
  const { api, orgId, t } = useSession();
  const [items, setItems] = useState<Q[]>([]);
  const [reply, setReply] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Q[]>(`/orgs/${orgId}/queries`).then((r) => setItems(r.filter((q) => q.status === 'open' || q.status === 'answered'))).catch((e: Error) => setError(e.message));
  }, [api, orgId]);
  useFocusEffect(load);

  async function send(id: string) {
    try {
      await api(`/orgs/${orgId}/queries/${id}/messages`, { body: { body: reply[id] } });
      setReply({ ...reply, [id]: '' });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Screen>
      <H1>{t('queries.title')}</H1>
      <Err>{error}</Err>
      {items.map((q) => (
        <Card key={q.id}>
          <P>{q.first_message}</P>
          {q.last_message && q.last_message !== q.first_message ? <P muted>{q.last_message}</P> : null}
          {q.status === 'open' && (
            <>
              <Field label={t('queries.reply')} value={reply[q.id] ?? ''} onChangeText={(v) => setReply({ ...reply, [q.id]: v })} multiline />
              <Button title={t('queries.reply')} onPress={() => send(q.id)} disabled={!reply[q.id]?.trim()} />
            </>
          )}
        </Card>
      ))}
    </Screen>
  );
}
