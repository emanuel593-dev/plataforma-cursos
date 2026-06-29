import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getProfile } from '../services/profiles.service';
import type { Profile } from '../types';

/**
 * Hook to access the current user's profile from AuthContext,
 * or load an arbitrary user's profile by ID.
 *
 * Usage:
 *   const { profile, loading } = useProfile();           // current user
 *   const { profile, loading } = useProfile(someUserId); // specific user
 */
export function useProfile(userId?: string) {
  const { profile: authProfile, isLoading: authLoading } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (uid: string) => {
    setLoading(true);
    try {
      const p = await getProfile(uid);
      setProfile(p);
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userId) {
      // Load specific user
      load(userId);
    } else {
      // Mirror AuthContext profile
      setProfile(authProfile);
      setLoading(authLoading);
    }
  }, [userId, authProfile, authLoading, load]);

  const refresh = useCallback(async () => {
    const uid = userId ?? authProfile?.id;
    if (uid) await load(uid);
  }, [userId, authProfile, load]);

  return { profile, loading, refresh };
}
