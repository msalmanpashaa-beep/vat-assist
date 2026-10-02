import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '@/session';
import { C } from '@/theme';

export default function Start() {
  const { ready, me, orgId } = useSession();
  if (!ready) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={C.ink} /></View>;
  if (!me) return <Redirect href="/sign-in" />;
  if (!orgId) return <Redirect href="/onboarding" />;
  return <Redirect href="/home" />;
}
