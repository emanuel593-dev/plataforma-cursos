// GET /api/gdrive/token
//
// Returns a short-lived Google Drive access_token for the central coordinator
// account. The refresh_token is NEVER sent to the browser.
//
// Flow:
//   1. Read the singleton row from system_gdrive_token via service_role key.
//   2. If the access_token is still valid, return it immediately.
//   3. Otherwise, refresh via Google OAuth and persist the new tokens.
//
// Returns:
//   200  { access_token: string }            — valid token ready to use
//   503  { error: string }                   — system token not configured yet
//   502  { error: string }                   — Google refresh failed
//
// Required env vars:
//   GDRIVE_CLIENT_ID      — OAuth 2.0 client ID
//   GDRIVE_CLIENT_SECRET  — OAuth 2.0 client secret
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service role key (never expose to browser)

import { verifyAuthenticated } from './_auth';

const CLIENT_ID     = process.env.GDRIVE_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET ?? '';
const SUPABASE_URL  = process.env.SUPABASE_URL          ?? '';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const ALLOWED_ORIGIN = process.env.SITE_URL ?? process.env.URL ?? 'https://demo-lms.netlify.app';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Vary': 'Origin',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

function err(status: number, message: string) {
  return {
    statusCode: status,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

interface SystemTokenRow {
  id:            number;
  access_token:  string;
  refresh_token: string;
  expires_at:    number;
}

interface GoogleRefreshResponse {
  access_token:  string;
  expires_in:    number;
  error?:        string;
  error_description?: string;
}

async function supabaseGet(table: string, eq: [string, unknown]): Promise<SystemTokenRow | null> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${eq[0]}=eq.${eq[1]}&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey:        SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept:        'application/json',
    },
  });
  if (!res.ok) return null;
  const rows = await res.json() as SystemTokenRow[];
  return rows[0] ?? null;
}

async function supabaseUpsert(table: string, data: Partial<SystemTokenRow>): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey:         SERVICE_KEY,
      Authorization:  `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
  });
}

export const handler = async (event: {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
}) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return err(405, 'Method not allowed.');
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return err(503, 'Supabase service role not configured.');
  }

  const auth = await verifyAuthenticated(event.headers);
  if (!auth.ok) {
    return err(auth.statusCode, auth.error);
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return err(503, 'Google Drive OAuth não configurado.');
  }

  // ── Read system token row ─────────────────────────────────────────────────
  let row: SystemTokenRow | null;
  try {
    row = await supabaseGet('system_gdrive_token', ['id', 1]);
  } catch (e) {
    console.error('[gdrive-token] Supabase read error:', e);
    return err(502, 'Erro ao ler token do banco.');
  }

  if (!row) {
    return err(503, 'Google Drive central não configurado. Acesse Gestão → Google Drive para conectar.');
  }

  // ── Return immediately if still valid (with 5 min safety margin) ─────────
  if (Date.now() < row.expires_at - 5 * 60 * 1000) {
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ access_token: row.access_token }),
    };
  }

  // ── Refresh the access token ──────────────────────────────────────────────
  const params = new URLSearchParams({
    refresh_token: row.refresh_token,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  let refreshData: GoogleRefreshResponse;
  try {
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    refreshData = (await res.json()) as GoogleRefreshResponse;
  } catch (e) {
    console.error('[gdrive-token] Google refresh fetch error:', e);
    return err(502, 'Falha ao renovar token com o Google.');
  }

  if (refreshData.error) {
    console.error('[gdrive-token] Google refresh error:', refreshData.error, refreshData.error_description);
    // invalid_grant means refresh_token was revoked, expired (7-day cap on apps
    // in "Testing" status), or the test users list changed and the original
    // grantee is no longer authorized. Surface this distinctly so the UI can
    // prompt for re-authentication instead of silently failing uploads.
    if (refreshData.error === 'invalid_grant') {
      return err(401,
        'Token do Google Drive expirou ou foi revogado. É necessário reconectar a conta em Gestão → Google Drive. ' +
        '(Apps em status "Testing" no Google Cloud Console invalidam tokens a cada 7 dias OU quando a lista de Test Users muda.)',
      );
    }
    return err(502, refreshData.error_description ?? refreshData.error);
  }

  const newExpiresAt = Date.now() + (refreshData.expires_in - 60) * 1000;

  // ── Persist updated tokens ─────────────────────────────────────────────────
  try {
    await supabaseUpsert('system_gdrive_token', {
      id:           1,
      access_token: refreshData.access_token,
      refresh_token: row.refresh_token, // refresh_token doesn't change on refresh
      expires_at:   newExpiresAt,
    });
  } catch (e) {
    console.error('[gdrive-token] Supabase upsert error:', e);
    // Non-fatal — still return the new token
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ access_token: refreshData.access_token }),
  };
};
