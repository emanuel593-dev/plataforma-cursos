import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

type ChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE';

interface UseRealtimeOptions<T extends Record<string, unknown>> {
  /** Supabase table name to subscribe to. */
  table: string;
  /** Schema (default: 'public'). */
  schema?: string;
  /** Optional filter, e.g. "class_id=eq.abc". */
  filter?: string;
  /** Events to listen for (default: all). */
  events?: ChangeEvent[];
  /** Callback fired on each change. */
  onPayload: (payload: RealtimePostgresChangesPayload<T>) => void;
  /** Whether the subscription is active (default: true). */
  enabled?: boolean;
}

/**
 * Subscribes to Supabase Realtime postgres_changes on a table.
 * No-ops gracefully when Supabase is not configured (localStorage mode).
 *
 * Usage:
 * ```ts
 * useRealtime<Attendance>({
 *   table: 'attendance',
 *   filter: `scheduled_lesson_id=eq.${lessonId}`,
 *   onPayload(p) { refetch(); },
 * });
 * ```
 */
export function useRealtime<T extends Record<string, unknown>>(
  opts: UseRealtimeOptions<T>,
) {
  const {
    table,
    schema = 'public',
    filter,
    events = ['INSERT', 'UPDATE', 'DELETE'],
    onPayload,
    enabled = true,
  } = opts;

  const [status, setStatus] = useState<'CONNECTING' | 'SUBSCRIBED' | 'CLOSED' | 'DISABLED'>('DISABLED');
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setStatus('CLOSED');
    }
  }, []);

  useEffect(() => {
    if (!enabled || !isSupabaseConfigured) {
      setStatus('DISABLED');
      return;
    }

    setStatus('CONNECTING');

    const channelName = `realtime:${schema}:${table}:${filter ?? 'all'}`;
    const channel = supabase.channel(channelName);

    for (const event of events) {
      const cfg: Record<string, string> = {
        event,
        schema,
        table,
      };
      if (filter) cfg.filter = filter;

      channel.on(
        'postgres_changes' as any,
        cfg,
        (payload: RealtimePostgresChangesPayload<T>) => {
          onPayloadRef.current(payload);
        },
      );
    }

    channel.subscribe((s) => {
      if (s === 'SUBSCRIBED') setStatus('SUBSCRIBED');
    });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
    // Re-subscribe when key params change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, schema, filter, enabled]);

  return { status, unsubscribe };
}
