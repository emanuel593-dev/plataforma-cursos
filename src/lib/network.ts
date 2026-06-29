// Network guard helper used by service write functions to short-circuit
// mutations when the device is offline AND we're talking to a real backend.
// In localStorage-only mode (isSupabaseConfigured === false) writes always
// succeed locally, so we don't block.

import { isSupabaseConfigured } from './supabase';

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export class OfflineError extends Error {
  constructor(message = 'Você está offline. Reconecte-se para concluir esta ação.') {
    super(message);
    this.name = 'OfflineError';
  }
}

/** Throws OfflineError when running against Supabase and the browser reports
 *  no network. Safe no-op in localStorage mode. */
export function assertOnline(): void {
  if (!isSupabaseConfigured) return;
  if (isOffline()) throw new OfflineError();
}
