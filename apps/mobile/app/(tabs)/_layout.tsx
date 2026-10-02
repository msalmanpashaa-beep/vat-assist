import { Tabs } from 'expo-router';
import { useSession } from '@/session';
import { C, F } from '@/theme';

export default function TabsLayout() {
  const { t } = useSession();
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: C.ink, tabBarLabelStyle: { fontFamily: F.bold, fontSize: 13 }, tabBarStyle: { minHeight: 60 } }}>
      <Tabs.Screen name="home" options={{ title: t('nav.home') }} />
      <Tabs.Screen name="capture" options={{ title: t('nav.capture') }} />
      <Tabs.Screen name="money" options={{ title: t('nav.money') }} />
      <Tabs.Screen name="returns" options={{ title: t('nav.returns') }} />
    </Tabs>
  );
}
