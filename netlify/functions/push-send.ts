// POST /api/push/send
//
// Body: {
//   userIds?: string[]      // target users (one of userIds OR endpoints required)
//   endpoints?: string[]
//   title: string
//   body?: string
//   url?: string
//   tag?: string
//   kind?: 'lesson-reminder' | 'lesson-started' | 'lesson-cancelled' | 'announcement' | string
//   requireInteraction?: boolean
//   vibrate?: number[]
// }
//
// Auth: requires a Bearer token belonging to a coordenacao profile, OR
//       the SUPABASE_SERVICE_ROLE_KEY (used by scheduled functions).
// Env:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import webpush from 'web-push';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:plataforma@talentsflow.com.br';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function authorizeRequest(headers: Record<string, string | undefined>): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  // Netlify normalizes header names to lowercase on some runtimes and not
  // others (Functions v1 vs v2). Always work from a lowercased snapshot so
  // lookups are deterministic — see audit M4.
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    h[k.toLowerCase()] = v;
  }

  // Internal trust: callers (e.g. scheduled functions) may pass the service-role key directly.
  const internal = h['x-internal-key'];
  if (internal && internal === SUPABASE_SERVICE_ROLE_KEY) return { ok: true };

  // Otherwise require a bearer token belonging to coordenacao.
  const auth = h.authorization;
  const token = auth?.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, status: 401, error: 'Token ausente.' };

  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!u.ok) return { ok: false, status: 401, error: 'Token inválido.' };
  const user = await u.json() as { id: string };

  const p = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
  });
  const profiles = await p.json() as Array<{ role: string }>;
  if (!profiles?.[0] || profiles[0].role !== 'coordenacao') {
    return { ok: false, status: 403, error: 'Apenas coordenação pode disparar push.' };
  }
  return { ok: true };
}

async function fetchSubscriptions(userIds: string[] | undefined, endpoints: string[] | undefined): Promise<SubscriptionRow[]> {
  const headers = {
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: SUPABASE_SERVICE_ROLE_KEY,
  };
  const filters: string[] = [];
  if (userIds && userIds.length) filters.push(`user_id=in.(${userIds.map(encodeURIComponent).join(',')})`);
  if (endpoints && endpoints.length) filters.push(`endpoint=in.(${endpoints.map(encodeURIComponent).join(',')})`);
  if (!filters.length) return [];
  const url = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,user_id,endpoint,p256dh,auth&${filters.join('&')}`;
  const r = await fetch(url, { headers });
  if (!r.ok) return [];
  return await r.json() as SubscriptionRow[];
}

async function deleteSubscription(id: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });
}

// ── Delivery telemetry ───────────────────────────────────────────────────────
// Best-effort PATCH that records last successful/failed delivery. Used by the
// client to decide whether to fall back to a local notification when the
// push channel appears to be silently dropping messages.
async function markDelivery(id: string, ok: boolean): Promise<void> {
  const field = ok ? 'last_delivery_at' : 'last_failure_at';
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey:        SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({ [field]: new Date().toISOString() }),
    });
  } catch { /* telemetry is best-effort */ }
}

export const handler = async (event: {
  httpMethod: string;
  body: string | null;
  headers: Record<string, string | undefined>;
}) => {
  const respHeaders = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: respHeaders, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers: respHeaders, body: JSON.stringify({ error: 'Servidor de push não configurado.' }) };
  }

  const auth = await authorizeRequest(event.headers);
  if (!auth.ok) return { statusCode: auth.status, headers: respHeaders, body: JSON.stringify({ error: auth.error }) };

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const { userIds, endpoints, title, body, url, tag, kind, requireInteraction, vibrate } = parsed as {
    userIds?: string[]; endpoints?: string[]; title?: string; body?: string; url?: string;
    tag?: string; kind?: string; requireInteraction?: boolean; vibrate?: number[];
  };

  if (!title) {
    return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: '`title` é obrigatório.' }) };
  }

  const subs = await fetchSubscriptions(userIds, endpoints);
  if (subs.length === 0) {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, failed: 0, removed: 0 }) };
  }

  const payload = JSON.stringify({ title, body, url, tag, kind, requireInteraction, vibrate });

  let sent = 0, failed = 0, removed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 },
      );
      sent++;
      // Telemetry: record successful delivery so the client can detect a
      // silently broken channel and fall back to a local notification.
      void markDelivery(s.id, true);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 = subscription gone — clean up.
      if (status === 404 || status === 410) {
        await deleteSubscription(s.id);
        removed++;
      } else {
        failed++;
        void markDelivery(s.id, false);
        console.error('[IV push] send error', status, err);
      }
    }
  }));

  return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent, failed, removed }) };
};
