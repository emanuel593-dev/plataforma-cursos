import { useEffect, useState } from 'react';

export type NetworkState = 'online' | 'offline' | 'reconnecting';

/**
 * Extended network status hook.
 *
 * Returns three possible states:
 *  - 'online':       navigator.onLine is true and connection is stable
 *  - 'offline':      navigator.onLine is false (no network at all)
 *  - 'reconnecting': browser fired 'online' but we haven't confirmed the
 *                    connection is fully restored yet (brief grace window)
 *
 * The 'reconnecting' state prevents the UI from flashing "online" for a
 * split second on flaky mobile connections that bounce on/off rapidly.
 */
export function useNetworkStatus(): { isOnline: boolean; networkState: NetworkState } {
  const [networkState, setNetworkState] = useState<NetworkState>(
    navigator.onLine ? 'online' : 'offline'
  );

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const handleOffline = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setNetworkState('offline');
    };

    const handleOnline = () => {
      // Brief 'reconnecting' state to avoid false positives on flaky links
      setNetworkState('reconnecting');
      reconnectTimer = setTimeout(() => {
        setNetworkState('online');
      }, 2000);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  return {
    isOnline: networkState === 'online',
    networkState,
  };
}
