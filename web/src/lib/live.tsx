import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';

/** Live data: the server pushes "topics changed" over SSE; hooks refetch when their topic bumps. */
type Versions = Record<string, number>;
const LiveCtx = createContext<{ versions: Versions; connected: boolean; bump: (...t: string[]) => void }>({ versions: {}, connected: false, bump: () => {} });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [versions, setVersions] = useState<Versions>({});
  const [connected, setConnected] = useState(false);
  const bump = useCallback((...topics: string[]) => {
    setVersions((v) => {
      const n = { ...v };
      for (const t of topics) n[t] = (n[t] ?? 0) + 1;
      return n;
    });
  }, []);
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => setConnected(true);
      es.addEventListener('change', (e) => {
        const { topics } = JSON.parse((e as MessageEvent).data);
        bump(...topics);
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, [bump]);
  return <LiveCtx.Provider value={{ versions, connected, bump }}>{children}</LiveCtx.Provider>;
}

export const useLive = () => useContext(LiveCtx);

export function useApi<T = any>(url: string | null, topics: string[] = []) {
  const { versions } = useLive();
  const key = topics.map((t) => versions[t] ?? 0).join('.');
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!url) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    api
      .get<T>(url)
      .then((data) => n === seq.current && setState({ data, loading: false }))
      .catch((error) => n === seq.current && setState((s) => ({ ...s, error, loading: false })));
  }, [url]);
  useEffect(load, [load, key]);
  return { ...state, reload: load };
}
