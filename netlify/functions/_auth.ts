// Usage:
//   const auth = await verifyAuthenticated(event.headers);
//   if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
//
//   const coord = await verifyCoordinator(event.headers);
//   if (!coord.ok) return { statusCode: coord.statusCode, headers, body: JSON.stringify({ error: coord.error }) };

declare const process: { env: Record<string, string | undefined> };

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export type AuthResult =
  | { ok: true; userId: string; role: string }
  | { ok: false; statusCode: number; error: string };

/** Lowercase header lookup — Netlify headers may arrive in any case. */
function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/**
 * Verifies the Supabase JWT in the Authorization header. Returns the user id
 * and the role from `profiles`. Does NOT enforce any specific role.
 */
export async function verifyAuthenticated(
  headers: Record<string, string | undefined> | undefined,
): Promise<AuthResult> {
  const authHeader = getHeader(headers, 'authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, statusCode: 401, error: 'Não autorizado.' };
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!userRes.ok) return { ok: false, statusCode: 401, error: 'Token inválido.' };
  const user = (await userRes.json()) as { id: string };

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
    {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    },
  );
  if (!profileRes.ok) return { ok: false, statusCode: 401, error: 'Perfil não encontrado.' };
  const profiles = (await profileRes.json()) as Array<{ role: string }>;
  const role = profiles?.[0]?.role;
  if (!role) return { ok: false, statusCode: 401, error: 'Perfil não encontrado.' };

  return { ok: true, userId: user.id, role };
}

/** Same as `verifyAuthenticated` but additionally requires role === 'coordenacao'. */
export async function verifyCoordinator(
  headers: Record<string, string | undefined> | undefined,
): Promise<AuthResult> {
  const result = await verifyAuthenticated(headers);
  if (!result.ok) return result;
  if (result.role !== 'coordenacao') {
    return { ok: false, statusCode: 403, error: 'Apenas coordenação pode executar esta ação.' };
  }
  return result;
}
