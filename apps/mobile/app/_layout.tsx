import { AtkinsonHyperlegibleNext_400Regular, AtkinsonHyperlegibleNext_700Bold, AtkinsonHyperlegibleNext_800ExtraBold, useFonts } from '@expo-google-fonts/atkinson-hyperlegible-next';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '@/session';
import { C, F } from '@/theme';

export default function Root() {
  const [loaded] = useFonts({ AtkinsonHyperlegibleNext_400Regular, AtkinsonHyperlegibleNext_700Bold, AtkinsonHyperlegibleNext_800ExtraBold });
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerTintColor: C.ink, headerTitleStyle: { fontFamily: F.bold }, contentStyle: { backgroundColor: C.page } }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
