'use client';

import { createContext, type ReactNode, useContext } from 'react';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string;
  banned?: boolean | null;
  mustChangePassword?: boolean;
}

interface AuthContextType {
  enabled: false;
  user: AuthUser | null;
  isPending: false;
  authMode: 'disabled';
  quotaMode: 'disabled';
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const disabledContext: AuthContextType = {
  enabled: false,
  user: null,
  isPending: false,
  authMode: 'disabled',
  quotaMode: 'disabled',
  signOut: async () => undefined,
  refresh: async () => undefined,
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode; enabled?: false }) {
  return <AuthContext.Provider value={disabledContext}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
