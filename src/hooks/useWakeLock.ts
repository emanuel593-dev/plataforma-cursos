import { useEffect, useRef } from 'react';

/**
 * Holds the Screen Wake Lock while `active` is true.
 *
 * On mobile (Android Chrome, iOS 16.4+ Safari) the OS aggressively dims and
 * suspends pages when the screen times out — this throttles WebRTC audio /
 * video transmission. Holding a wake lock during a live call prevents the
 * screen from sleeping, which is the most common cause of "remote can't hear
 * me anymore" issues in PWAs.
 *
 * Best-effort: silently no-ops on browsers that don't support `navigator.wakeLock`.
 */
export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined') return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
    };
    if (!nav.wakeLock?.request) return;

    let cancelled = false;

    async function acquire() {
      try {
        const sentinel = await nav.wakeLock!.request('screen');
        if (cancelled) {
          try { await sentinel.release(); } catch { /* ignore */ }
          return;
        }
        sentinelRef.current = sentinel;
        sentinel.addEventListener('release', () => {
          // OS may release on tab hide; we'll re-acquire on visibilitychange.
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        });
      } catch {
        // Ignored: user gesture missing, permission denied, etc.
      }
    }

    function onVisibility() {
      if (document.visibilityState === 'visible' && !sentinelRef.current) {
        void acquire();
      }
    }

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinelRef.current;
      sentinelRef.current = null;
      if (s) {
        try { void s.release(); } catch { /* ignore */ }
      }
    };
  }, [active]);
}
