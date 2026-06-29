// POST /api/push/fj-assigned
//
// Body: { attendanceId: string }
//
// Auth: Bearer token of a coordinator or professor.
//
// Effect: sends a push notification to the student informing them they
//         received a justified absence (FJ) and must watch the recording
//         and submit a summary before the deadline to avoid an F.
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import webpush from 'web-push';

const SUPABASE_URL              = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const VAPID_PUBLIC              = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE             = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT             = process.env.VAPID_SUBJECT ?? 'mailto:plataforma@talentsflow.com.br';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

interface SubscriptionRow {
  id: string; user_id: string; endpoint: string; p256dh: string; auth: string;
}

const SR_HEADERS = {
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  apikey:        SUPABASE_SERVICE_ROLE_KEY,
};

async function sb<T>(path: string): Promise<T | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SR_HEADERS });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

async function deleteSubscription(id: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${id}`, {
    method: 'DELETE', headers: SR_HEADERS,
  });
}

function formatDeadline(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
  } catch { return iso; }
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
    return { statusCode: 500, headers: respHeaders, body: JSON.stringify({ error: 'Push não configurado.' }) };
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization ?? (event.headers.Authorization as string | undefined);
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers: respHeaders, body: JSON.stringify({ error: 'Token ausente.' }) };
  }
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!u.ok) {
    return { statusCode: 401, headers: respHeaders, body: JSON.stringify({ error: 'Token inválido.' }) };
  }
  const caller = (await u.json()) as { id: string };
  const profiles = await sb<Array<{ role: string }>>(`profiles?id=eq.${caller.id}&select=role`);
  const callerRole = profiles?.[0]?.role;
  if (callerRole !== 'coordenacao' && callerRole !== 'professor') {
    return { statusCode: 403, headers: respHeaders, body: JSON.stringify({ error: 'Acesso negado.' }) };
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  let parsed: { attendanceId?: string };
  try { parsed = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const { attendanceId } = parsed;
  if (!attendanceId || typeof attendanceId !== 'string') {
    return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: '`attendanceId` é obrigatório.' }) };
  }

  // ── Load attendance row ───────────────────────────────────────────────────
  const rows = await sb<Array<{
    id: string;
    student_id: string;
    scheduled_lesson_id: string;
    makeup_deadline: string | null;
  }>>(`attendance?id=eq.${attendanceId}&select=id,student_id,scheduled_lesson_id,makeup_deadline`);

  const att = rows?.[0];
  if (!att) {
    return { statusCode: 404, headers: respHeaders, body: JSON.stringify({ error: 'Registro de frequência não encontrado.' }) };
  }

  // ── Resolve class for deep-link ───────────────────────────────────────────
  let classId: string | null = null;
  let className = '';
  try {
    const slRows = await sb<Array<{ class_id: string; classes?: { name?: string } }>>(
      `scheduled_lessons?id=eq.${att.scheduled_lesson_id}&select=class_id,classes(name)`,
    );
    if (slRows?.[0]) {
      classId  = slRows[0].class_id ?? null;
      className = slRows[0].classes?.name ?? '';
    }
  } catch { /* best-effort */ }

  // ── Build notification body ───────────────────────────────────────────────
  const deadlineText = att.makeup_deadline
    ? ` Prazo: ${formatDeadline(att.makeup_deadline)}.`
    : '';

  const title = 'Falta justificada registrada';
  const body  = `${className ? `${className} — ` : ''}Assista a gravação da aula e envie o resumo para efetivar a reposição.${deadlineText}`;
  const url   = classId ? `/turmas/${classId}?tab=reposicao` : '/gravacoes';

  // ── Fetch subscriptions + send ────────────────────────────────────────────
  const subs = await sb<SubscriptionRow[]>(
    `push_subscriptions?user_id=eq.${att.student_id}&select=id,user_id,endpoint,p256dh,auth`,
  );
  if (!subs || subs.length === 0) {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, reason: 'no subscriptions' }) };
  }

  const payload = JSON.stringify({
    title,
    body,
    url,
    tag:                `fj-assigned-${att.id}`,
    kind:               'fj-assigned',
    requireInteraction: false,
    vibrate:            [80, 40, 80],
  });

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24 },
      );
      sent++;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await deleteSubscription(s.id);
      else console.error('[fj-assigned] push error', status, err);
    }
  }));

  return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent }) };
};
