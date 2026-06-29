import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { UserRole } from '../types';
import PageLoader from './ui/PageLoader';
import Button from './ui/Button';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /**
   * Roles that are allowed to see this content. REQUIRED — default-deny:
   * never omit this prop. Passing an empty array blocks all roles.
   */
  allowedRoles: UserRole[];
}

export default function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { profile, isLoading, profileError, refreshProfile } = useAuth();

  // Show a spinner while the auth state / profile is resolving
  if (isLoading) {
    return <PageLoader />;
  }

  // If profile failed to load, show a recoverable error instead of a blank page
  if (!profile) {
    if (profileError) {
      return (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
          <p className="text-iv-muted text-sm">{profileError}</p>
          <Button size="sm" variant="secondary" onClick={() => refreshProfile()}>Tentar novamente</Button>
        </div>
      );
    }
    return <PageLoader />;
  }

  if (!allowedRoles.includes(profile.role)) {
    if (typeof console !== 'undefined') {
      console.warn(`[ProtectedRoute] role '${profile.role}' negado (permitidos: ${allowedRoles.join(', ') || '∅'})`);
    }    // Fire-and-forget audit log — never block the render.
    if (isSupabaseConfigured) {
      void (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<unknown>)(
        'log_role_denied',
        { p_denied_role: profile.role, p_route: window.location.pathname },
      );
    }    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-iv-muted text-sm">Você não tem permissão para acessar esta página.</p>
      </div>
    );
  }

  return <>{children}</>;
}
