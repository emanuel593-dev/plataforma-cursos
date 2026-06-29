// POST /api/push/makeup-submitted
//
// Body: { submissionId: string }
//
// Auth: Bearer token of the student submitting (or staff triggering on their behalf).
//
// Effect: sends a push notification to all coordinators informing them that
//         a student submitted a makeup summary and it is awaiting review.
//         Deep-links to /relatorios?tab=reposicoes.
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

  // ── Body ─────────────────────────────────────────────────────────────────
  let parsed: { submissionId?: string };
  try { parsed = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const { submissionId } = parsed;
  if (!submissionId || typeof submissionId !== 'string') {
    return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: '`submissionId` é obrigatório.' }) };
  }

  // ── Load submission ───────────────────────────────────────────────────────
  const subs = await sb<Array<{
    id: string;
    student_id: string;
    class_id: string | null;
    scheduled_lesson_id: string | null;
    recording_id: string | null;
  }>>(`makeup_submissions?id=eq.${submissionId}&select=id,student_id,class_id,scheduled_lesson_id,recording_id`);

  const submission = subs?.[0];
  if (!submission) {
    return { statusCode: 404, headers: respHeaders, body: JSON.stringify({ error: 'Submissão não encontrada.' }) };
  }

  // ── Resolve student name ──────────────────────────────────────────────────
  let studentName = 'Um aluno';
  try {
    const pRows = await sb<Array<{ full_name?: string; display_name?: string; name?: string }>>(
      `profiles?id=eq.${submission.student_id}&select=full_name,display_name,name`,
    );
    const p = pRows?.[0];
    studentName = p?.full_name ?? p?.display_name ?? p?.name ?? studentName;
  } catch { /* best-effort */ }

  // ── Resolve lesson title ──────────────────────────────────────────────────
  // Strategy (in order, stop at first hit):
  //   1. scheduled_lessons → lessons(title)  — canonical
  //   2. recordings.title                    — when the row is detached from a SL
  //   3. classes.name                        — last-resort, never empty
  let lessonTitle: string | null = null;
  try {
    if (submission.scheduled_lesson_id) {
      const slRows = await sb<Array<{ lessons?: { title?: string } | null }>>(
        `scheduled_lessons?id=eq.${submission.scheduled_lesson_id}&select=lessons(title)`,
      );
      lessonTitle = slRows?.[0]?.lessons?.title ?? null;
    }
    if (!lessonTitle && submission.recording_id) {
      const recRows = await sb<Array<{ title?: string }>>(
        `recordings?id=eq.${submission.recording_id}&select=title`,
      );
      lessonTitle = recRows?.[0]?.title ?? null;
    }
    if (!lessonTitle && submission.class_id) {
      const clsRows = await sb<Array<{ name?: string }>>(
        `classes?id=eq.${submission.class_id}&select=name`,
      );
      const className = clsRows?.[0]?.name;
      if (className) lessonTitle = `aula da turma ${className}`;
    }
  } catch { /* best-effort */ }
  lessonTitle = lessonTitle ?? 'uma aula';

  // ── Get coordinator user IDs ──────────────────────────────────────────────
  const coordProfiles = await sb<Array<{ id: string }>>(`profiles?role=eq.coordenacao&select=id`);
  const coordIds = coordProfiles?.map((r) => r.id) ?? [];
  if (coordIds.length === 0) {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, reason: 'no coordinators' }) };
  }

  // ── Fetch subscriptions of all coordinators ───────────────────────────────
  const subscriptionRows = await sb<SubscriptionRow[]>(
    `push_subscriptions?user_id=in.(${coordIds.join(',')})&select=id,user_id,endpoint,p256dh,auth`,
  );
  if (!subscriptionRows || subscriptionRows.length === 0) {
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent: 0, reason: 'no subscriptions' }) };
  }

  const payload = JSON.stringify({
    title: 'Nova reposição para revisão',
    body:  `${studentName} enviou o resumo de ${lessonTitle}.`,
    url:   '/relatorios?tab=reposicoes',
    tag:   `makeup-submitted-${submissionId}`,
    kind:  'makeup-submitted',
    requireInteraction: true,
    vibrate: [100, 50, 100],
  });

  let sent = 0;
  await Promise.all(subscriptionRows.map(async (s) => {
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
      else console.error('[makeup-submitted] push error', status, err);
    }
  }));

  return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ sent }) };
};
