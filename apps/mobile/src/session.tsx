import { type Locale, type MeResponse, type MessageKey, type SessionTokens, t as translate } from '@vat-assist/shared';
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';
const KEY = 'vatassist.session';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

type Init = { method?: string; body?: unknown };

interface Session {
  ready: boolean;
  me: MeResponse | null;
  orgId: string | null;
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  api: <T>(path: string, init?: Init) => Promise<T>;
  signIn: (tokens: SessionTokens) => Promise<void>;
  signOut: () => Promise<void>;
  reloadMe: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

function deviceLocale(): Locale {
  const code = getLocales()[0]?.languageCode;
  return code === 'fr' ? 'fr' : 'en';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const tokens = useRef<SessionTokens | null>(null);
  const refreshing = useRef<Promise<boolean> | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [ready, setReady] = useState(false);

  const save = useCallback(async (t: SessionTokens | null) => {
    tokens.current = t;
    if (t) await SecureStore.setItemAsync(KEY, JSON.stringify(t));
    else await SecureStore.deleteItemAsync(KEY);
  }, []);

  /** One refresh at a time: refresh tokens rotate, and reusing an old one signs every device out. */
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!refreshing.current) {
      refreshing.current = (async () => {
        const rt = tokens.current?.refreshToken;
        if (!rt) return false;
        const res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
        if (!res.ok) {
          await save(null);
          setMe(null);
          return false;
        }
        await save((await res.json()) as SessionTokens);
        return true;
      })().finally(() => {
        refreshing.current = null;
      });
    }
    return refreshing.current;
  }, [save]);

  const api = useCallback(async <T,>(path: string, init: Init = {}): Promise<T> => {
    const send = () =>
      fetch(`${API_URL}${path}`, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers: {
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(tokens.current ? { authorization: `Bearer ${tokens.current.accessToken}` } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    let res = await send();
    if (res.status === 401 && tokens.current && (await refresh())) res = await send();
    const text = await res.text();
    const data = text ? (JSON.parse(text) as { message?: string; code?: string }) : null;
    if (!res.ok) throw new ApiError(res.status, data?.message ?? `Error ${res.status}`, data?.code);
    return data as T;
  }, [refresh]);

  const reloadMe = useCallback(async () => {
    setMe(await api<MeResponse>('/me'));
  }, [api]);

  useEffect(() => {
    (async () => {
      const raw = await SecureStore.getItemAsync(KEY);
      if (raw) {
        tokens.current = JSON.parse(raw) as SessionTokens;
        try {
          await reloadMe();
        } catch {
          await save(null);
        }
      }
      setReady(true);
    })();
  }, [reloadMe, save]);

  const value = useMemo<Session>(() => {
    const locale = me?.user.locale ?? deviceLocale();
    const shop = me?.memberships.find((m) => m.role === 'owner' || m.role === 'staff');
    return {
      ready, me, locale, orgId: shop?.orgId ?? null,
      t: (key, vars) => translate(locale, key, vars),
      api,
      signIn: async (t) => {
        await save(t);
        await reloadMe();
      },
      signOut: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        await save(null);
        setMe(null);
      },
      reloadMe,
    };
  }, [ready, me, api, save, reloadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
