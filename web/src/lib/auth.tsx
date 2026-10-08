import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useLive } from './live';

export interface Me {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'staff';
  primary_process_id: number | null;
  unread: number;
}
interface AuthState {
  user: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => void;
}
const Ctx = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    api
      .get<Me>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    const h = () => setUser(null);
    window.addEventListener('umami:unauthorized', h);
    return () => window.removeEventListener('umami:unauthorized', h);
  }, []);
  const login = async (email: string, password: string) => {
    await api.post('/auth/login', { email, password });
    refresh();
  };
  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
  };
  return <Ctx.Provider value={{ user, loading, login, logout, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
export const useIsAdmin = () => useAuth().user?.role === 'admin';

/** Keep the unread badge fresh when notifications change. */
export function useUnreadSync() {
  const { versions } = useLive();
  const { refresh } = useAuth();
  useEffect(() => {
    if (versions.notifications) refresh();
  }, [versions.notifications, refresh]);
}
