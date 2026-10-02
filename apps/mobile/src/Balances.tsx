import { formatRs } from '@vat-assist/shared';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useSession } from './session';
import { C, F } from './theme';
import { Card } from './ui';

/** Cash and bank as the books see them, straight from the journal. */
export function Balances() {
  const { api, orgId, locale } = useSession();
  const [rows, setRows] = useState<Array<{ tag: string; name: string; balance_cents: number }>>([]);
  useFocusEffect(useCallback(() => {
    if (orgId) api<typeof rows>(`/orgs/${orgId}/balances`).then(setRows).catch(() => undefined);
  }, [api, orgId]));
  const shown = rows.filter((r) => r.tag === 'cash' || r.tag === 'bank' || r.balance_cents !== 0);
  if (!shown.length) return null;
  return (
    <Card>
      {shown.map((r) => (
        <View key={r.tag} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
          <Text style={{ fontFamily: F.regular, fontSize: 16, color: C.slate }}>{r.name}</Text>
          <Text style={{ fontFamily: F.bold, fontSize: 16, color: C.slate }}>{formatRs(r.balance_cents, locale)}</Text>
        </View>
      ))}
    </Card>
  );
}
