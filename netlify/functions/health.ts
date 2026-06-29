// GET /api/health
//
// Public liveness endpoint — no auth required. Used by monitoring tools,
// uptime checks, and the future metrics dashboard (Phase 4 Q4).
//
// Returns an aggregated health snapshot:
//   {
//     ok: boolean,           // true when all critical checks pass
//     ts: string,            // ISO-8601 timestamp of this check
//     checks: {
//       supabase:  { ok: boolean, latencyMs?: number, error?: string },
//       turn:      { ok: boolean, configured: boolean, error?: string },
//       push_subs: { ok: boolean, count?: number, error?: string }
//     }
//   }
//
// HTTP status: 200 when all ok, 503 when any critical check fails.
//
// Env vars used (same as other functions):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN
//
// NOTE: TURN liveness issues a real Cloudflare credential-generation call.
// The TTL is capped at 60 s to avoid wasting the quota allocation.

declare const process: { env: Record<string, string | undefined> };

const SUPABASE_URL             = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const CF_TURN_KEY_ID           = process.env.CLOUDFLARE_TURN_KEY_ID ?? '';
const CF_TURN_API_TOKEN        = process.env.CLOUDFLARE_TURN_API_TOKEN ?? '';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  configured?: boolean;
  count?: number;
  error?: string;
}

interface HealthPayload {
  ok: boolean;
  ts: string;
  checks: {
    supabase: CheckResult;
    turn: CheckResult;
    push_subs: CheckResult;
  };
}

async function checkSupabase(): Promise<CheckResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set' };
  }
  const start = Date.now();
  try {
    // Hit the REST health endpoint — requires service role for RLS bypass.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      // 5 s timeout via AbortController
      signal: AbortSignal.timeout(5_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function checkTurn(): Promise<CheckResult> {
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) {
    return { ok: true, configured: false };
  }
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CF_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 60 }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) {
      return { ok: false, configured: true, error: `Cloudflare HTTP ${res.status}` };
    }
    return { ok: true, configured: true };
  } catch (err) {
    return { ok: false, configured: true, error: String(err) };
  }
}

async function checkPushSubs(): Promise<CheckResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: 'Supabase not configured' };
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?select=id&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          // Ask PostgREST for the total row count in the Content-Range header.
          Prefer: 'count=exact',
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    // Content-Range: 0-0/42  →  "42"
    const range = res.headers.get('Content-Range') ?? '';
    const totalStr = range.split('/')[1];
    const count = totalStr ? parseInt(totalStr, 10) : undefined;
    return { ok: true, count: isNaN(count as number) ? undefined : count };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const handler = async (event: { httpMethod: string }) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed.' }),
    };
  }

  // Run all checks concurrently.
  const [supabase, turn, push_subs] = await Promise.all([
    checkSupabase(),
    checkTurn(),
    checkPushSubs(),
  ]);

  const ok = supabase.ok && push_subs.ok;  // TURN misconfiguration is not critical
  const payload: HealthPayload = {
    ok,
    ts: new Date().toISOString(),
    checks: { supabase, turn, push_subs },
  };

  return {
    statusCode: ok ? 200 : 503,
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  };
};
