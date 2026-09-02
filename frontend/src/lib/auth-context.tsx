'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiJson, setAccessToken } from './api';

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  terms_accepted?: boolean;
  terms_version?: string | null;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await apiJson<User>('/api/users/me');
      setUser(profile);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // Ao carregar a app, tenta usar o refresh cookie para obter sessão.
    (async () => {
      try {
        const { accessToken } = await apiJson<{ accessToken: string }>('/api/auth/refresh', {
          method: 'POST',
        });
        setAccessToken(accessToken);
        await refreshProfile();
      } catch {
        setAccessToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshProfile]);

  const login = useCallback(
    async (email: string, password: string) => {
      const data = await apiJson<{ accessToken: string; user: User }>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      setAccessToken(data.accessToken);
      await refreshProfile();
    },
    [refreshProfile],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const data = await apiJson<{ accessToken: string; user: User }>('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      setAccessToken(data.accessToken);
      await refreshProfile();
    },
    [refreshProfile],
  );

  const logout = useCallback(async () => {
    await apiJson('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>');
  return ctx;
}
