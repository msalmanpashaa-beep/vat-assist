import { type FeatureSet, resolveFeatures } from '@vat-assist/shared';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useSession } from './session';

/** The business's feature flags (set by Nex-Gen). The API enforces them too; this only hides what is off. */
export function useFeatures(): FeatureSet {
  const { api, orgId } = useSession();
  const [f, setF] = useState<FeatureSet>(resolveFeatures(null));
  useFocusEffect(useCallback(() => {
    if (orgId) api<FeatureSet>(`/orgs/${orgId}/features`).then(setF).catch(() => undefined);
  }, [api, orgId]));
  return f;
}
