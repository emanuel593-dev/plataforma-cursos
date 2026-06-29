// POST /api/gdrive/auth
//
// Handles Google Drive OAuth 2.0 token exchange and refresh.
// The client_secret NEVER leaves this function.
//
// Request body shapes:
//   { action: 'exchange', code: string, redirectUri: string }
//     → returns { access_token, refresh_token, expires_at }
//       (per-user flow, kept for compatibility)
//
//   { action: 'exchange', code: string, redirectUri: string, isSystem: true }
//     → Requires caller to be 'coordenacao' (validated via Supabase JWT).
//       Stores tokens in system_gdrive_token table via service_role.
//       Returns { ok: true }
//
//   { action: 'refresh', refreshToken: string }
//     → returns { access_token, expires_at }
//
// Required env vars:
//   GDRIVE_CLIENT_ID          — OAuth 2.0 client ID
//   GDRIVE_CLIENT_SECRET      — OAuth 2.0 client secret (never sent to browser)
//   SUPABASE_URL              — Supabase project URL (for isSystem path)
//   SUPABASE_SERVICE_ROLE_KEY — service role key (for isSystem path)

const CLIENT_ID     = process.env.GDRIVE_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET ?? '';
const SUPABASE_URL  = process.env.SUPABASE_URL          ?? '';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

// Restrict CORS to our deploy origin (audit M3). Falls back to Netlify's
// auto-injected URL so preview deploys keep working.
const ALLOWED_ORIGIN = process.env.SITE_URL ?? process.env.URL ?? 'https://demo-lms.netlify.app';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  Vary: 'Origin',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

interface ExchangeBody {
  action: 'exchange';
  code: string;
  redirectUri: string;
  isSystem?: boolean;
}

interface RefreshBody {
  action: 'refresh';
  refreshToken: string;
}

interface GoogleTokenResponse {
  access_token:  string;
  refresh_token?: string;
  expires_in:    number;
  token_type:    string;
  error?:        string;
  error_description?: string;
}

function err(status: number, message: string) {
  return {
    statusCode: status,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

export const handler = async (event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return err(405, 'Method not allowed.');
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return err(503, 'Google Drive OAuth não configurado. Defina GDRIVE_CLIENT_ID e GDRIVE_CLIENT_SECRET.');
  }

  let body: ExchangeBody | RefreshBody;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return err(400, 'Invalid JSON body.');
  }

  // ── Exchange authorization code for tokens ────────────────────────────────
  if (body.action === 'exchange') {
    const { code, redirectUri } = body as ExchangeBody;
    if (!code || !redirectUri) {
      return err(400, 'Missing required fields: code, redirectUri.');
    }

    const params = new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    });

    let tokenData: GoogleTokenResponse;
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      tokenData = (await res.json()) as GoogleTokenResponse;
    } catch (e) {
      console.error('[gdrive-auth] Token exchange fetch error:', e);
      return err(502, 'Failed to reach Google OAuth endpoint.');
    }

    if (tokenData.error) {
      console.error('[gdrive-auth] Token exchange error:', tokenData.error, tokenData.error_description);
      return err(400, tokenData.error_description ?? tokenData.error);
    }

    const expiresAt = Date.now() + (tokenData.expires_in - 60) * 1000; // 60s safety margin

    // ── System token: store in DB, never return refresh_token to client ──────
    if ((body as ExchangeBody).isSystem) {
      // Verify caller has coordenacao role via Supabase JWT
      const authHeader = event.headers['authorization'] ?? event.headers['Authorization'] ?? '';
      const userJwt    = authHeader.replace(/^Bearer\s+/i, '');

      if (!userJwt) {
        return err(401, 'Authorization header required for isSystem exchange.');
      }

      // Validate JWT and get user ID via Supabase auth API
      let userId: string | undefined;
      try {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: {
            apikey:        SERVICE_KEY,
            Authorization: `Bearer ${userJwt}`,
          },
        });
        if (!userRes.ok) {
          return err(401, 'Token JWT inválido.');
        }
        const userMeta = await userRes.json() as { id?: string };
        userId = userMeta.id;
      } catch {
        return err(502, 'Erro ao verificar autenticação.');
      }

      if (!userId) {
        return err(401, 'Não foi possível identificar o usuário.');
      }

      // Look up role from the profiles table (role is NOT stored in auth user_metadata)
      let role: string | undefined;
      try {
        const profileRes = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=role&limit=1`,
          {
            headers: {
              apikey:        SERVICE_KEY,
              Authorization: `Bearer ${SERVICE_KEY}`,
              Accept:        'application/json',
            },
          },
        );
        if (profileRes.ok) {
          const rows = await profileRes.json() as Array<{ role?: string }>;
          role = rows[0]?.role;
        }
      } catch {
        return err(502, 'Erro ao verificar perfil do usuário.');
      }

      if (role !== 'coordenacao') {
        return err(403, 'Apenas a coordenação pode configurar o Drive central.');
      }

      if (!tokenData.refresh_token) {
        return err(400, 'Google não retornou refresh_token. Tente novamente com prompt=consent.');
      }

      // Persist to system_gdrive_token table
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/system_gdrive_token`, {
          method: 'POST',
          headers: {
            apikey:         SERVICE_KEY,
            Authorization:  `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            Prefer:         'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            id:            1,
            access_token:  tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at:    expiresAt,
          }),
        });
      } catch (e) {
        console.error('[gdrive-auth] Failed to persist system token:', e);
        return err(502, 'Erro ao salvar token do sistema.');
      }

      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        access_token:  tokenData.access_token,
        refresh_token: tokenData.refresh_token ?? null,
        expires_at:    expiresAt,
      }),
    };
  }

  // ── Refresh access token ─────────────────────────────────────────────────
  if (body.action === 'refresh') {
    const { refreshToken } = body as RefreshBody;
    if (!refreshToken) {
      return err(400, 'Missing required field: refreshToken.');
    }

    const params = new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
    });

    let tokenData: GoogleTokenResponse;
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      tokenData = (await res.json()) as GoogleTokenResponse;
    } catch (e) {
      console.error('[gdrive-auth] Token refresh fetch error:', e);
      return err(502, 'Failed to reach Google OAuth endpoint.');
    }

    if (tokenData.error) {
      console.error('[gdrive-auth] Token refresh error:', tokenData.error, tokenData.error_description);
      // 401 so the client knows it needs to re-authorize
      return err(401, tokenData.error_description ?? tokenData.error);
    }

    const expiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        access_token: tokenData.access_token,
        expires_at:   expiresAt,
      }),
    };
  }

  return err(400, 'Unknown action. Expected "exchange" or "refresh".');
};
