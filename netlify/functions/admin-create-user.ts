// POST /api/admin/create-user
// Creates a new Supabase Auth user. Requires coordenacao role.

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
  headers: Record<string, string | undefined>;
  body: string | null;
}) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const auth = await verifyCoordinator(
    event.headers['authorization'] ?? event.headers['Authorization'],
  );
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { email, fullName, password, role } = parsed as {
    email?: string;
    fullName?: string;
    password?: string;
    role?: string;
  };

  if (!email || !fullName || !password || !role) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'email, fullName, password e role são obrigatórios.' }),
    };
  }

  const { ok, status, body } = await supabaseAdminFetch('/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    }),
  });

  if (!ok) {
    const msg =
      (body as { msg?: string; message?: string }).msg ??
      (body as { msg?: string; message?: string }).message ??
      'Erro ao criar usuário.';
    return { statusCode: status, headers, body: JSON.stringify({ error: msg }) };
  }

  const user = body as { id: string; email: string };
  return { statusCode: 200, headers, body: JSON.stringify({ id: user.id, email: user.email }) };
};
