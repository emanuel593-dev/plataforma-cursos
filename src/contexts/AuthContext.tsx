import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import type { AuthUser } from '../services/auth.service';
import type { Profile } from '../types';
import {
  onAuthStateChanged,
  signIn as doSignIn,
  signUp as doSignUp,
  signOut as doSignOut,
  getProfile,
  checkMustChangePassword,
  changePassword as doChangePassword,
} from '../services/auth.service';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

// Supabase auth-js refreshes the JWT on REST calls, but views that rely only
// on Realtime sockets (long classrooms, idle dashboards) can outlive the
// access-token TTL (~1h) and silently drop. Refresh proactively every 55 min
// while the tab is open and authenticated (audit M5).
const SESSION_REFRESH_INTERVAL_MS = 55 * 60 * 1000;

interface AuthState {
  user: AuthUser | null;
  profile: Profile | null;
  isLoading: boolean;
  profileError: string | null;
  isAuthenticated: boolean;
  mustChangePassword: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  // Track latest load to avoid stale updates after unmount / rapid auth changes
  const loadCounterRef = useRef(0);

  const loadProfile = useCallback(async (uid: string | null) => {
    if (!uid) {
      setProfile(null);
      setProfileError(null);
      setMustChangePassword(false);
      return;
    }
    const token = ++loadCounterRef.current;
    try {
      const p = await getProfile(uid);
      if (token !== loadCounterRef.current) return; // stale — discard
      setProfile(p);
      setProfileError(null);
      const mustChange = await checkMustChangePassword(uid);
      if (token !== loadCounterRef.current) return;
      setMustChangePassword(mustChange);
    } catch (err) {
      if (token !== loadCounterRef.current) return;
      // Surface the error so the UI can show a retry instead of a blank page
      setProfile(null);
      setProfileError(err instanceof Error ? err.message : 'Falha ao carregar perfil.');
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(async (authUser) => {
      setUser(authUser);
      await loadProfile(authUser?.id ?? null);
      setIsLoading(false);
    });
    return unsub;
  }, [loadProfile]);

  // Proactive token refresh (M5). Only meaningful in Supabase mode; the
  // localStorage dev path has no JWT to refresh.
  useEffect(() => {
    if (!isSupabaseConfigured || !user) return;
    const id = window.setInterval(() => {
      void supabase.auth.refreshSession().catch((e) => {
        console.warn('[AuthContext] proactive refreshSession failed', e);
      });
    }, SESSION_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [user]);

  const signIn = useCallback(async (email: string, password: string) => {
    const authUser = await doSignIn(email, password);
    setUser(authUser);
    await loadProfile(authUser.id);
  }, [loadProfile]);

  const signUp = useCallback(async (email: string, password: string, fullName: string) => {
    const authUser = await doSignUp(email, password, fullName);
    setUser(authUser);
    await loadProfile(authUser.id);
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await doSignOut();
    setUser(null);
    setProfile(null);
    setProfileError(null);
    setMustChangePassword(false);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) await loadProfile(user.id);
  }, [user, loadProfile]);

  const changePassword = useCallback(async (newPassword: string) => {
    if (!user) throw new Error('Não autenticado.');
    await doChangePassword(user.id, newPassword);
    setMustChangePassword(false);
  }, [user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        isLoading,
        profileError,
        isAuthenticated: !!user,
        mustChangePassword,
        signIn,
        signUp,
        signOut,
        refreshProfile,
        changePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
