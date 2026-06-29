// Web Push (VAPID) — client subscribe / unsubscribe + persist subscription in
// `push_subscriptions` so the Netlify function `push-send` can deliver
// notifications even when the PWA is closed.
//
// Public VAPID key is exposed via `VITE_VAPID_PUBLIC_KEY`.
// Subscriptions are user-scoped via the `push_subscriptions.user_id` column
// (RLS already restricts read/write to the owner).

import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { PushSubscriptionInsert } from '../types';

const VAPID_PUBLIC = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';

export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC) && isPushSupported();
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const norm = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(norm);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}

export async function subscribeToPush(userId: string): Promise<PushSubscription | null> {
  if (!isPushConfigured()) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as unknown as BufferSource,
      });
    } catch (e) {
      console.warn('[IV push] subscribe failed', e);
      return null;
    }
  }
  await persistSubscription(userId, sub);
  return sub;
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch { /* noop */ }
    if (isSupabaseConfigured) {
      try { await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint); } catch { /* noop */ }
    }
  }
}

async function persistSubscription(userId: string, sub: PushSubscription): Promise<void> {
  if (!isSupabaseConfigured) return;
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh ?? arrayBufferToBase64(sub.getKey('p256dh'));
  const auth   = json.keys?.auth   ?? arrayBufferToBase64(sub.getKey('auth'));
  if (!p256dh || !auth || !sub.endpoint) return;

  const payload: PushSubscriptionInsert = {
    user_id: userId,
    endpoint: sub.endpoint,
    p256dh,
    auth,
    user_agent: navigator.userAgent,
  };

  // Use SECURITY DEFINER RPC to atomically claim/rebind endpoint ownership.
  // This avoids RLS failures when the same browser endpoint already exists
  // under another user (shared device or account switch).
  // `register_push_subscription` is created via migration 013; until generated
  // DB types include this RPC signature, call through a narrow any cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc('register_push_subscription', {
    p_endpoint: payload.endpoint,
    p_p256dh: payload.p256dh,
    p_auth: payload.auth,
    p_user_agent: payload.user_agent ?? null,
  });

  // Temporary fallback while migration 013 is not applied in an environment.
  if (error && /function\s+register_push_subscription|does not exist/i.test(error.message)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fallback = await (supabase.from('push_subscriptions') as any)
      .upsert(payload, { onConflict: 'endpoint' });
    if (fallback.error) console.warn('[IV push] persist failed', fallback.error.message);
    return;
  }

  if (error) console.warn('[IV push] persist failed', error.message);
}

/** Idempotent: ensures the user has a fresh subscription if permission is granted. */
export async function ensurePushSubscription(userId: string): Promise<void> {
  if (!isPushConfigured()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  await subscribeToPush(userId);
}
