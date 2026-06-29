// POST /.netlify/functions/admin-promote-managed
//
// Promove um perfil "managed only" (criado pela coordenação sem auth.users
// — alunos/professores presenciais) para uma conta real com login.
//
// Fluxo:
//   1. Valida que o caller é coordenacao.
//   2. Valida que o profile alvo existe e tem is_managed_only=true.
//   3. Cria auth.users com o MESMO UUID do profile (preserva FKs em
//      enrollments, class_professors, attendance etc.).
//   4. O trigger handle_new_user (mig 034) faz ON CONFLICT DO UPDATE no
//      profile: seta email, is_managed_only=false, mantém full_name/role.
//   5. Dispara recovery link (magic link de definição de senha) se solicitado.
//
// Body: { profileId: string, email: string, sendInvite?: boolean }
// Resposta: { id, email }

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SITE_URL = process.env.URL ?? process.env.DEPLOY_URL ?? 'http://localhost:8888';

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

async function adminApi(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function restGet<T>(path: string): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!r.ok) throw new Error(`supabase rest ${path}: ${r.status}`);
  return await r.json() as T;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  role: string;
  is_managed_only: boolean;
  email: string | null;
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

  const { profileId, email, sendInvite } = parsed as {
    profileId?: string;
    email?: string;
    sendInvite?: boolean;
  };

  if (!profileId || !email) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'profileId e email são obrigatórios.' }),
    };
  }

  // Sanity-check email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email inválido.' }) };
  }

  // ── 1. Verifica profile alvo ─────────────────────────────────────────────
  let target: ProfileRow | null = null;
  try {
    const rows = await restGet<ProfileRow[]>(
      `profiles?id=eq.${profileId}&select=id,full_name,role,is_managed_only,email`,
    );
    target = rows[0] ?? null;
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Falha ao consultar profile: ${(err as Error).message}` }),
    };
  }
  if (!target) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Perfil não encontrado.' }) };
  }
  if (!target.is_managed_only) {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({ error: 'Este perfil já é uma conta real.' }),
    };
  }

  // ── 2. Garante que o email não está em uso por outro usuário ─────────────
  try {
    const existingProfile = await restGet<Array<{ id: string }>>(
      `profiles?email=eq.${encodeURIComponent(email)}&select=id`,
    );
    if (existingProfile.length > 0 && existingProfile[0].id !== profileId) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Email já está em uso por outro perfil.' }),
      };
    }
  } catch {
    /* não-fatal — Supabase Auth fará a validação final */
  }

  // ── 3. Cria auth.users com MESMO UUID do profile ─────────────────────────
  // Supabase GoTrue admin POST /users aceita campo `id`. email_confirm=true
  // pula confirmação por email; user define senha via recovery link enviado
  // depois (sendInvite=true).
  const createRes = await adminApi('/users', {
    method: 'POST',
    body: JSON.stringify({
      id: profileId,
      email,
      email_confirm: true,
      user_metadata: {
        full_name: target.full_name ?? '',
        role: target.role,
      },
    }),
  });

  if (!createRes.ok) {
    const msg =
      (createRes.body as { msg?: string; message?: string }).msg ??
      (createRes.body as { msg?: string; message?: string }).message ??
      'Erro ao criar conta no Supabase Auth.';
    return { statusCode: createRes.status, headers, body: JSON.stringify({ error: msg }) };
  }

  // O trigger handle_new_user já fez ON CONFLICT DO UPDATE setando
  // is_managed_only=false e email — ver migration 034. Não precisamos de
  // UPDATE adicional aqui.

  // ── 4. (Opcional) Envia magic link para o usuário definir senha ──────────
  let inviteSent = false;
  if (sendInvite) {
    const recover = await adminApi('/generate_link', {
      method: 'POST',
      body: JSON.stringify({
        type: 'recovery',
        email,
        options: { redirect_to: `${SITE_URL}/` },
      }),
    });
    inviteSent = recover.ok;
    // Não bloqueamos o fluxo se falhar — coord pode reenviar manualmente.
  }

  // ── 5. Audit ────────────────────────────────────────────────────────────
  await fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([{
      actor_id: auth.requesterId,
      action: 'profile.managed_promoted',
      entity: 'profile',
      entity_id: profileId,
      details: { email, role: target.role, invite_sent: inviteSent },
    }]),
  }).catch(() => { /* audit best-effort */ });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ id: profileId, email, inviteSent }),
  };
};
