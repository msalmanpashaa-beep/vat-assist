import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, type TextInputProps, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, F, TOUCH } from './theme';

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View style={s.body}>{children}</View>}
    </SafeAreaView>
  );
}

export const H1 = ({ children }: { children: ReactNode }) => <Text style={s.h1} accessibilityRole="header">{children}</Text>;
export const H2 = ({ children }: { children: ReactNode }) => <Text style={s.h2} accessibilityRole="header">{children}</Text>;
export const P = ({ children, muted }: { children: ReactNode; muted?: boolean }) => <Text style={[s.p, muted && { color: C.muted }]}>{children}</Text>;
export const Err = ({ children }: { children: ReactNode }) => (children ? <Text style={s.err} accessibilityRole="alert">{children}</Text> : null);

export function Button({ title, onPress, kind = 'primary', busy, disabled }: { title: string; onPress: () => void; kind?: 'primary' | 'quiet' | 'danger'; busy?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={busy || disabled}
      style={({ pressed }) => [s.btn, kind === 'quiet' && s.btnQuiet, kind === 'danger' && s.btnDanger, (pressed || busy || disabled) && { opacity: 0.6 }]}
    >
      {busy ? <ActivityIndicator color={kind === 'quiet' ? C.ink : '#fff'} /> : <Text style={[s.btnText, kind === 'quiet' && { color: C.ink }]}>{title}</Text>}
    </Pressable>
  );
}

export function Chips<T extends string>({ options, value, onChange }: { options: Array<{ value: T; label: string }>; value: T | null; onChange: (v: T) => void }) {
  return (
    <View style={s.chips}>
      {options.map((o) => (
        <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ selected: value === o.value }} onPress={() => onChange(o.value)}
          style={[s.chip, value === o.value && s.chipOn]}>
          <Text style={[s.chipText, value === o.value && { color: '#fff' }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Field({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={C.muted} style={s.input} accessibilityLabel={label} {...input} />
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

export const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.page },
  body: { padding: 20, paddingBottom: 48 },
  h1: { fontFamily: F.heavy, fontSize: 28, color: C.slate, marginBottom: 8 },
  h2: { fontFamily: F.bold, fontSize: 20, color: C.slate, marginTop: 20, marginBottom: 8 },
  p: { fontFamily: F.regular, fontSize: 17, lineHeight: 25, color: C.slate, marginBottom: 8 },
  err: { fontFamily: F.bold, fontSize: 16, color: C.red, marginVertical: 8 },
  label: { fontFamily: F.bold, fontSize: 15, color: C.slate, marginBottom: 6 },
  input: { fontFamily: F.regular, fontSize: 18, minHeight: TOUCH, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 12, backgroundColor: C.paper, color: C.slate },
  btn: { minHeight: TOUCH, borderRadius: 6, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginVertical: 6 },
  btnQuiet: { backgroundColor: 'transparent', borderWidth: 2, borderColor: C.ink },
  btnDanger: { backgroundColor: C.red },
  btnText: { fontFamily: F.bold, fontSize: 18, color: '#fff' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 22, borderWidth: 2, borderColor: C.ink, backgroundColor: C.paper },
  chipOn: { backgroundColor: C.ink },
  chipText: { fontFamily: F.bold, fontSize: 16, color: C.ink },
  card: { backgroundColor: C.paper, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 16, marginBottom: 12 },
});
