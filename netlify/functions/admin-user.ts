// DELETE /api/admin/users/:uid  — remove a Supabase Auth user
// PATCH  /api/admin/users/:uid  — update a user's email
// Both require coordenacao role.

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

type CoordResult =
  | { ok: true; requesterId: string }
  | { ok: false; statusCode: number; error: string };

async function verifyCoordinator(authHeader: string | undefined): Promise<CoordResult> {
  const token = authHeader?.replace('Bearer ', '');
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
    { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_ROLE_KEY } },
  );
  const profiles = (await profileRes.json()) as Array<{ role: string }>;
  if (!profiles?.[0] || profiles[0].role !== 'coordenacao') {
    return { ok: false, statusCode: 403, error: 'Apenas coordenação pode executar esta ação.' };
  }

  return { ok: true, requesterId: user.id };
}

async function supabaseAdminFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}

export const handler = async (event: {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'DELETE' && event.httpMethod !== 'PATCH') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const auth = await verifyCoordinator(
    event.headers['authorization'] ?? event.headers['Authorization'],
  );
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
  }

  // Extract UID from the end of the path: /api/admin/users/<uid>
  const uid = event.path.split('/').filter(Boolean).pop();
  if (!uid) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'UID não fornecido.' }) };
  }

  if (event.httpMethod === 'DELETE') {
    const { ok, status, body } = await supabaseAdminFetch(`/users/${uid}`, { method: 'DELETE' });
    if (!ok) {
      const msg =
        (body as { msg?: string; message?: string }).msg ??
        (body as { msg?: string; message?: string }).message ??
        'Erro ao excluir usuário.';
      return { statusCode: status, headers, body: JSON.stringify({ error: msg }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // PATCH — update email
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { email } = parsed as { email?: string };
  if (!email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'email é obrigatório.' }) };
  }

  const { ok, status, body } = await supabaseAdminFetch(`/users/${uid}`, {
    method: 'PUT',
    body: JSON.stringify({ email }),
  });
  if (!ok) {
    const msg =
      (body as { msg?: string; message?: string }).msg ??
      (body as { msg?: string; message?: string }).message ??
      'Erro ao atualizar e-mail.';
    return { statusCode: status, headers, body: JSON.stringify({ error: msg }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
