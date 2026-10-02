jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@/session', () => {
  const h = require('./harness');
  return { useSession: () => ({ api: h.mockApi, orgId: 'org-1', locale: 'en', t: h.tr, me: null }) };
});
jest.mock('expo-router', () => {
  const React = require('react');
  const h = require('./harness');
  return {
    router: h.mockRouter,
    Stack: { Screen: () => null },
    useLocalSearchParams: () => h.state.params,
    useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]),
  };
});
jest.mock('@/features', () => {
  const h = require('./harness');
  return { useFeatures: () => h.state.features };
});
jest.mock('@/Balances', () => ({ Balances: () => null }));
